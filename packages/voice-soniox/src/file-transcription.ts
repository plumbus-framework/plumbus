import { ErrorCode, PlumbusError } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import type {
  FileTranscriptionConfig,
  FileTranscriptionDeleteResult,
  FileTranscriptionJob,
  FileTranscriptionOperationOptions,
  FileTranscriptionProvider,
  FileTranscriptionProviderRegistration,
  FileTranscriptionReconcileInput,
  FileTranscriptionReconcileUploadInput,
  FileTranscriptionSubmissionResult,
  FileTranscriptionSubmitInput,
  FileTranscriptionTranscript,
  FileTranscriptionUploadInput,
  FileTranscriptionUploadResult,
  FileTranscriptionUsage,
  FileTranscriptionUsageInput,
  VoiceProviderCredentials,
} from '@plumbus/voice/provider-kit';
import { FetchHttpClient, SonioxHttpError, SonioxNodeClient } from '@soniox/node';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const id = z.string().uuid();
const quantity = z.number().finite().nonnegative();
const count = quantity.int().safe();
const datetime = z.string().datetime({ offset: true });
const jobSchema = z.object({
  id,
  file_id: id,
  model: z.string().min(1).max(128),
  client_reference_id: z.string().max(256).nullish(),
  status: z.enum(['queued', 'processing', 'completed', 'error']),
  created_at: datetime,
  audio_duration_ms: quantity.nullish(),
});
const fileSchema = z.object({
  id,
  filename: z.string().max(256),
  size: count,
  created_at: datetime,
  client_reference_id: z.string().max(256).nullish(),
});
const usageSchema = z.object({
  uuid: id,
  model: z.string(),
  client_reference_id: z.string().nullish(),
  request_scope: z.string(),
  start_time: datetime,
  end_time: datetime,
  input_audio_tokens: count,
  input_text_tokens: count,
  output_text_tokens: count,
  input_audio_duration_ms: quantity,
  output_audio_tokens: z.literal(0),
  cost_usd: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .transform(Number)
    .pipe(quantity)
    .nullish(),
});
const windowSchema = z
  .object({ after: datetime, before: datetime })
  .refine(
    ({ after, before }) =>
      Date.parse(before) > Date.parse(after) &&
      Date.parse(before) - Date.parse(after) <= 7 * 86400000,
  );
function checked<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new PlumbusError(ErrorCode.Validation, 'Invalid file transcription data');
  return result.data;
}
function remoteError(error: unknown): PlumbusError {
  const status = error instanceof SonioxHttpError ? error.statusCode : undefined;
  return new PlumbusError(
    ErrorCode.DependencyViolation,
    'File transcription provider operation failed',
    {
      reason:
        status === 401 || status === 403
          ? 'authentication'
          : status === 402
            ? 'provider_budget'
            : status === 429
              ? 'rate_limit'
              : 'provider_unavailable',
      ...(status ? { providerStatus: status } : {}),
    },
  );
}
function definiteRefusal(error: unknown): boolean {
  return (
    error instanceof SonioxHttpError &&
    [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(error.statusCode ?? 0)
  );
}
function inWindow(value: string, after: string, before: string): boolean {
  return Date.parse(value) >= Date.parse(after) && Date.parse(value) < Date.parse(before);
}
function job(value: unknown): FileTranscriptionJob {
  const row = checked(jobSchema, value);
  return {
    jobId: row.id,
    fileId: row.file_id,
    model: row.model,
    ...(row.client_reference_id ? { clientReference: row.client_reference_id } : {}),
    status: row.status === 'error' ? 'failed' : row.status,
    createdAt: row.created_at,
    ...(row.audio_duration_ms != null ? { audioSeconds: row.audio_duration_ms / 1000 } : {}),
    ...(row.status === 'error' ? { errorCode: 'transcription_failed' } : {}),
  };
}

async function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  signal?.throwIfAborted();
  if (!signal) return iterator.next();
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    iterator
      .next()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** SDK-backed async file provider. Every method is a bounded operation, without paid retries. */
class SonioxFileTranscriptionProvider implements FileTranscriptionProvider {
  readonly #client: SonioxNodeClient;
  readonly #maxPages: number;
  readonly #pageSize: number;
  constructor(
    credentials: VoiceProviderCredentials,
    private readonly config: FileTranscriptionConfig,
  ) {
    const apiKey = checked(z.string().trim().min(1), credentials.apiKey);
    const region = checked(z.enum(['us', 'eu', 'jp']), config.region);
    const baseUrl = checked(
      z.string().url(),
      credentials.baseUrl ??
        (region === 'us' ? 'https://api.soniox.com' : `https://api.${region}.soniox.com`),
    );
    const url = new URL(baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['https:', 'http:'].includes(url.protocol)
    )
      throw new PlumbusError(ErrorCode.Validation, 'Invalid transcription provider URL');
    const fetcher =
      credentials.options?.fetch === undefined
        ? globalThis.fetch
        : checked(
            z.custom<typeof fetch>((value) => typeof value === 'function'),
            credentials.options.fetch,
          );
    // Bound the SDK's JSON allocation as well as decoded output. No redirect may forward credentials.
    const boundedFetch: typeof fetch = async (input, init) => {
      const response = await fetcher(input, { ...init, redirect: 'error' });
      const maxBytes = Math.min(16 * 1024 * 1024, Math.max(config.maxOutputBytes * 8, 1024 * 1024));
      if (!response.body) return response;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > maxBytes)
            throw new PlumbusError(
              ErrorCode.Validation,
              'Transcription provider response exceeds limit',
            );
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(total ? bytes : null, {
        status: response.status,
        headers: response.headers,
      });
    };
    this.#client = new SonioxNodeClient({
      api_key: apiKey,
      base_url: baseUrl,
      http_client: new FetchHttpClient({
        base_url: baseUrl,
        default_headers: { Authorization: `Bearer ${apiKey}` },
        default_timeout_ms: config.timeoutMs ?? 30000,
        fetch: boundedFetch,
      }),
    });
    this.#maxPages = config.maxPages ?? 10;
    this.#pageSize = config.pageSize ?? 100;
  }

  async upload(
    input: FileTranscriptionUploadInput,
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionUploadResult> {
    const reference = checked(opaque, input.uploadReference);
    checked(z.string().regex(/^(audio|video)\/[A-Za-z0-9.+-]+$/), input.contentType);
    const size = checked(
      z.number().int().positive().max(this.config.maxInputBytes),
      input.byteLength,
    );
    options.signal?.throwIfAborted();
    // The SDK itself buffers streams. Check size before any external write and never silently truncate.
    const bytes = new Uint8Array(size);
    let offset = 0;
    const source = input.bytes;
    const iterator = (async function* () {
      if (source instanceof Uint8Array) yield source;
      else yield* source;
    })()[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await nextChunk(iterator, options.signal);
        if (item.done) break;
        const chunk = checked(z.instanceof(Uint8Array), item.value);
        offset += chunk.byteLength;
        if (offset > size)
          throw new PlumbusError(
            ErrorCode.Validation,
            'File transcription input exceeds declared size',
          );
        bytes.set(chunk, offset - chunk.byteLength);
      }
    } finally {
      // A blocked app stream must not prevent cancellation from returning.
      void iterator.return?.().catch(() => undefined);
    }
    if (offset !== size)
      throw new PlumbusError(ErrorCode.Validation, 'File transcription input size mismatch');
    options.signal?.throwIfAborted();
    try {
      const file = checked(
        fileSchema,
        (
          await this.#client.files.upload(bytes, {
            filename: reference,
            client_reference_id: reference,
            signal: options.signal,
            timeout_ms: this.config.timeoutMs,
          })
        ).toJSON(),
      );
      if (
        file.size !== size ||
        file.filename !== reference ||
        file.client_reference_id !== reference
      )
        return { state: 'unknown', uploadReference: reference, reason: 'outcome_unknown' };
      return { state: 'uploaded', fileId: file.id, uploadReference: reference };
    } catch (error) {
      if (definiteRefusal(error)) throw remoteError(error);
      return { state: 'unknown', uploadReference: reference, reason: 'outcome_unknown' };
    }
  }

  async reconcileUpload(
    input: FileTranscriptionReconcileUploadInput,
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionUploadResult> {
    const reference = checked(opaque, input.uploadReference);
    checked(count, input.byteLength);
    checked(windowSchema, { after: input.createdAfter, before: input.createdBefore });
    let cursor: string | undefined;
    const matches = new Map<string, string>();
    const cursors = new Set<string>();
    try {
      for (let page = 0; page < this.#maxPages; page++) {
        const result = await this.#client.files.list({
          limit: this.#pageSize,
          cursor,
          signal: options.signal,
        });
        for (const value of result.files) {
          const row = checked(fileSchema, value.toJSON());
          if (
            row.client_reference_id === reference &&
            row.filename === reference &&
            row.size === input.byteLength &&
            inWindow(row.created_at, input.createdAfter, input.createdBefore)
          )
            matches.set(row.id, row.id);
        }
        if (matches.size > 1)
          return { state: 'unknown', uploadReference: reference, reason: 'ambiguous' };
        if (!result.next_page_cursor) {
          const fileId = matches.values().next().value;
          return fileId
            ? { state: 'uploaded', fileId, uploadReference: reference }
            : { state: 'unknown', uploadReference: reference, reason: 'not_found' };
        }
        cursor = result.next_page_cursor;
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
      }
      return { state: 'unknown', uploadReference: reference, reason: 'page_limit' };
    } catch (error) {
      throw remoteError(error);
    }
  }

  async submit(
    input: FileTranscriptionSubmitInput,
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionSubmissionResult> {
    checked(id, input.fileId);
    checked(opaque, input.clientReference);
    options.signal?.throwIfAborted();
    try {
      const result = job(
        (
          await this.#client.stt.create(
            {
              model: this.config.model,
              file_id: input.fileId,
              client_reference_id: input.clientReference,
              language_hints: this.config.languageHints,
              language_hints_strict: false,
              enable_language_identification: true,
              enable_speaker_diarization: true,
            },
            options.signal,
          )
        ).toJSON(),
      );
      if (
        result.fileId !== input.fileId ||
        result.model !== this.config.model ||
        result.clientReference !== input.clientReference
      )
        return { state: 'unknown', reason: 'outcome_unknown' };
      return { state: 'submitted', job: result };
    } catch (error) {
      if (definiteRefusal(error)) throw remoteError(error);
      return { state: 'unknown', reason: 'outcome_unknown' };
    }
  }

  async reconcileSubmission(
    input: FileTranscriptionReconcileInput,
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionSubmissionResult> {
    checked(id, input.fileId);
    checked(opaque, input.clientReference);
    checked(windowSchema, { after: input.createdAfter, before: input.createdBefore });
    let cursor: string | undefined;
    const matches = new Map<string, FileTranscriptionJob>();
    const cursors = new Set<string>();
    try {
      for (let page = 0; page < this.#maxPages; page++) {
        const result = await this.#client.stt.list(
          { limit: this.#pageSize, cursor },
          options.signal,
        );
        for (const value of result.transcriptions) {
          const row = job(value.toJSON());
          if (
            row.fileId === input.fileId &&
            row.model === this.config.model &&
            row.clientReference === input.clientReference &&
            inWindow(row.createdAt, input.createdAfter, input.createdBefore)
          )
            matches.set(row.jobId, row);
        }
        if (matches.size > 1) return { state: 'unknown', reason: 'ambiguous' };
        if (!result.next_page_cursor) {
          const match = matches.values().next().value;
          return match
            ? { state: 'submitted', job: match }
            : { state: 'unknown', reason: 'not_found' };
        }
        cursor = result.next_page_cursor;
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
      }
      return { state: 'unknown', reason: 'page_limit' };
    } catch (error) {
      throw remoteError(error);
    }
  }

  async getJob(
    input: { jobId: string },
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionJob | null> {
    checked(id, input.jobId);
    try {
      const result = await this.#client.stt.get(input.jobId, options.signal);
      if (!result) return null;
      const parsed = job(result.toJSON());
      if (parsed.jobId !== input.jobId || parsed.model !== this.config.model)
        throw new PlumbusError(ErrorCode.Validation, 'Transcription job identity mismatch');
      return parsed;
    } catch (error) {
      throw remoteError(error);
    }
  }

  async getTranscript(
    input: { jobId: string },
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionTranscript | null> {
    checked(id, input.jobId);
    try {
      const result = await this.#client.stt.getTranscript(input.jobId, options.signal);
      if (!result) return null;
      const parsed = checked(
        z.object({
          id,
          text: z.string().max(this.config.maxOutputBytes),
          tokens: z
            .array(
              z
                .object({
                  text: z.string().max(this.config.maxOutputBytes),
                  start_ms: count,
                  end_ms: count,
                  confidence: z.number().min(0).max(1).optional(),
                  language: z.string().max(32).nullish(),
                  speaker: z.string().max(128).nullish(),
                  translation_status: z.enum(['none', 'original']).nullish(),
                })
                .refine((token) => token.end_ms >= token.start_ms),
            )
            .max(this.config.maxTokens ?? 100000),
        }),
        result,
      );
      if (
        parsed.id !== input.jobId ||
        Buffer.byteLength(parsed.text) > this.config.maxOutputBytes ||
        parsed.tokens.reduce((total, token) => total + Buffer.byteLength(token.text), 0) >
          this.config.maxOutputBytes
      )
        throw new PlumbusError(
          ErrorCode.Validation,
          'Transcription output identity or size mismatch',
        );
      return {
        text: parsed.text,
        tokens: parsed.tokens.map((token) => ({
          text: token.text,
          startMs: token.start_ms,
          endMs: token.end_ms,
          ...(token.confidence !== undefined ? { confidence: token.confidence } : {}),
          ...(token.language ? { language: token.language } : {}),
          ...(token.speaker ? { speaker: token.speaker } : {}),
        })),
      };
    } catch (error) {
      throw remoteError(error);
    }
  }

  async getUsage(
    input: FileTranscriptionUsageInput,
    options: FileTranscriptionOperationOptions = {},
  ): Promise<FileTranscriptionUsage> {
    checked(id, input.jobId);
    checked(opaque, input.clientReference);
    checked(windowSchema, { after: input.startedAfter, before: input.endedBefore });
    const receipt =
      input.verifiedJob === undefined
        ? undefined
        : checked(
            z
              .object({
                jobId: id,
                fileId: id,
                model: z.string().min(1).max(128),
                clientReference: opaque,
                status: z.enum(['completed', 'failed']),
                createdAt: datetime,
                audioSeconds: quantity.optional(),
                errorCode: z.string().max(128).optional(),
              })
              .strict(),
            input.verifiedJob,
          );
    if (
      receipt &&
      (receipt.jobId !== input.jobId ||
        receipt.fileId !== checked(id, input.fileId) ||
        receipt.model !== this.config.model ||
        receipt.clientReference !== input.clientReference ||
        !inWindow(receipt.createdAt, input.startedAfter, input.endedBefore))
    )
      return { state: 'unknown', reason: 'ambiguous' };
    const live = await this.getJob({ jobId: input.jobId }, options);
    if (
      live &&
      receipt &&
      (live.fileId !== receipt.fileId ||
        live.clientReference !== receipt.clientReference ||
        live.createdAt !== receipt.createdAt ||
        live.status !== receipt.status)
    )
      return { state: 'unknown', reason: 'ambiguous' };
    const knownJob = live ?? receipt;
    if (!knownJob) return { state: 'unknown', reason: 'not_found' };
    if (input.fileId !== undefined && knownJob.fileId !== checked(id, input.fileId))
      return { state: 'unknown', reason: 'ambiguous' };
    if (knownJob.clientReference !== input.clientReference)
      return { state: 'unknown', reason: 'ambiguous' };
    if (knownJob.status !== 'completed' && knownJob.status !== 'failed')
      return { state: 'unknown', reason: 'not_found' };
    let cursor: string | undefined;
    const matches = new Map<string, z.infer<typeof usageSchema>>();
    const cursors = new Set<string>();
    try {
      for (let page = 0; page < this.#maxPages; page++) {
        const result = await this.#client.usageLogs.list({
          start_time: input.startedAfter,
          end_time: input.endedBefore,
          limit: this.#pageSize,
          cursor,
          signal: options.signal,
        });
        for (const value of result.usage_logs) {
          if (value.client_reference_id !== input.clientReference && value.uuid !== input.jobId)
            continue;
          const row = checked(usageSchema, value);
          if (
            row.model !== this.config.model ||
            row.client_reference_id !== input.clientReference ||
            Date.parse(row.start_time) < Date.parse(knownJob.createdAt) ||
            !inWindow(row.end_time, input.startedAfter, input.endedBefore)
          )
            return { state: 'unknown', reason: 'ambiguous' };
          const old = matches.get(row.uuid);
          if (old && JSON.stringify(old) !== JSON.stringify(row))
            return { state: 'unknown', reason: 'ambiguous' };
          matches.set(row.uuid, row);
          if (matches.size > 1) return { state: 'unknown', reason: 'ambiguous' };
        }
        if (!result.next_page_cursor) {
          const match = matches.values().next().value;
          return match
            ? {
                state: 'known',
                providerUsageId: match.uuid,
                audioSeconds: match.input_audio_duration_ms / 1000,
                inputAudioTokens: match.input_audio_tokens,
                inputTextTokens: match.input_text_tokens,
                outputTextTokens: match.output_text_tokens,
                costUsd: match.cost_usd ?? null,
              }
            : { state: 'unknown', reason: 'not_found' };
        }
        cursor = result.next_page_cursor;
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
      }
      return { state: 'unknown', reason: 'page_limit' };
    } catch (error) {
      throw remoteError(error);
    }
  }

  async #delete(
    kind: 'job' | 'file',
    value: string,
    options: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionDeleteResult> {
    checked(id, value);
    try {
      if (kind === 'job') await this.#client.stt.delete(value, options.signal);
      else await this.#client.files.delete(value, options.signal);
      return { state: 'deleted' };
    } catch (error) {
      if (error instanceof SonioxHttpError && error.statusCode === 409) return { state: 'pending' };
      throw remoteError(error);
    }
  }
  deleteJob(input: { jobId: string }, options: FileTranscriptionOperationOptions = {}) {
    return this.#delete('job', input.jobId, options);
  }
  deleteFile(input: { fileId: string }, options: FileTranscriptionOperationOptions = {}) {
    return this.#delete('file', input.fileId, options);
  }
}

export const SONIOX_FILE_TRANSCRIPTION_REGISTRATION: FileTranscriptionProviderRegistration =
  Object.freeze({
    id: 'soniox',
    create: (credentials: VoiceProviderCredentials, config: FileTranscriptionConfig) =>
      new SonioxFileTranscriptionProvider(credentials, config),
  });
