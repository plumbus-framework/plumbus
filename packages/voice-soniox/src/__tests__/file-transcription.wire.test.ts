import { createFileTranscriptionRuntime } from '@plumbus/voice/transcription';
import type {
  FileTranscriptionConfig,
  FileTranscriptionContext,
} from '@plumbus/voice/provider-kit';
import { describe, expect, it, vi } from 'vitest';
import { SONIOX_FILE_TRANSCRIPTION_REGISTRATION } from '../index.js';

const fileId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const reference = 'opaque-request-0000001';
const config: FileTranscriptionConfig = {
  model: 'stt-async-v5',
  region: 'eu',
  maxInputBytes: 1024,
  maxOutputBytes: 1024,
  languageHints: ['he', 'en'],
  maxPages: 2,
  pageSize: 2,
};
const ctx = { ai: { checkProviderCostBudget: vi.fn() } } as unknown as FileTranscriptionContext;
const admitted = { estimatedCostUsd: 0.01 };
const file = {
  id: fileId,
  filename: reference,
  size: 4,
  created_at: '2026-10-13T10:00:00Z',
  client_reference_id: reference,
};
const providerJob = {
  id: jobId,
  file_id: fileId,
  model: config.model,
  client_reference_id: reference,
  status: 'completed',
  created_at: file.created_at,
  audio_duration_ms: 12000,
};
const window = { createdAfter: '2026-10-13T09:59:00Z', createdBefore: '2026-10-13T10:01:00Z' };
const usage = {
  uuid: jobId,
  request_scope: 'api',
  model: config.model,
  client_reference_id: reference,
  start_time: file.created_at,
  end_time: '2026-10-13T10:00:12Z',
  input_audio_tokens: 100,
  input_text_tokens: 3,
  output_text_tokens: 7,
  output_audio_tokens: 0,
  input_audio_duration_ms: 12000,
  cost_usd: '0.000185',
};
const usageInput = {
  jobId,
  clientReference: reference,
  startedAfter: window.createdAfter,
  endedBefore: window.createdBefore,
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function setup(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  override: Partial<FileTranscriptionConfig> = {},
) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(url)), init),
  );
  const runtime = createFileTranscriptionRuntime({
    registration: SONIOX_FILE_TRANSCRIPTION_REGISTRATION,
    credentials: { apiKey: 'test-no-live-key', options: { fetch: fetcher } },
    config: { ...config, ...override },
  });
  return { runtime, fetcher };
}
function usageSetup(handler: () => Response) {
  return setup((url) =>
    url.pathname === `/v1/transcriptions/${jobId}` ? json(providerJob) : handler(),
  );
}
function uploadInput(bytes: Uint8Array | AsyncIterable<Uint8Array> = new Uint8Array([1, 2, 3, 4])) {
  return { bytes, byteLength: 4, contentType: 'video/mp4', uploadReference: reference };
}

describe('Soniox asynchronous file transcription (official SDK with fake transport)', () => {
  it('uploads MP4 bytes under only an opaque filename and configured region', async () => {
    const value = setup(async (url, init) => {
      expect(url.origin).toBe('https://api.eu.soniox.com');
      expect(url.pathname).toBe('/v1/files');
      expect(init?.redirect).toBe('error');
      expect(init?.method).toBe('POST');
      const body = init?.body as FormData;
      expect(body.get('client_reference_id')).toBe(reference);
      const blob = body.get('file') as File;
      expect(blob.name).toBe(reference);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
      return json(file);
    });
    expect(await value.runtime.upload(ctx, uploadInput(), admitted)).toEqual({
      state: 'uploaded',
      fileId,
      uploadReference: reference,
    });
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts bounded streams and rejects short/oversized input before HTTP', async () => {
    const value = setup(() => json(file));
    async function* chunks() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    }
    expect((await value.runtime.upload(ctx, uploadInput(chunks()), admitted)).state).toBe(
      'uploaded',
    );
    value.fetcher.mockClear();
    await expect(
      value.runtime.upload(ctx, uploadInput(new Uint8Array(5)), admitted),
    ).rejects.toThrow('exceeds declared size');
    await expect(
      value.runtime.upload(ctx, uploadInput(new Uint8Array(3)), admitted),
    ).rejects.toThrow('size mismatch');
    await expect(
      value.runtime.upload(ctx, { ...uploadInput(), byteLength: 2048 }, admitted),
    ).rejects.toThrow('Invalid');
    expect(value.fetcher).not.toHaveBeenCalled();
  });
  it('keeps interrupted uploads unknown and reconciles by exact opaque reference, size and time', async () => {
    const value = setup((url, init) => {
      if (init?.method === 'POST') throw new TypeError('lost response');
      expect(url.pathname).toBe('/v1/files');
      return json({ files: [file, { ...file, id: otherId, size: 9 }], next_page_cursor: null });
    });
    expect(await value.runtime.upload(ctx, uploadInput(), admitted)).toEqual({
      state: 'unknown',
      reason: 'outcome_unknown',
      uploadReference: reference,
    });
    expect(
      await value.runtime.reconcileUpload(ctx, {
        uploadReference: reference,
        byteLength: 4,
        ...window,
      }),
    ).toEqual({ state: 'uploaded', fileId, uploadReference: reference });
    expect(value.fetcher.mock.calls.filter((row) => row[1]?.method === 'POST')).toHaveLength(1);
  });
  it('leaves ambiguous upload cleanup unresolved instead of selecting the first match', async () => {
    const value = setup(() =>
      json({ files: [file, { ...file, id: otherId }], next_page_cursor: null }),
    );
    expect(
      await value.runtime.reconcileUpload(ctx, {
        uploadReference: reference,
        byteLength: 4,
        ...window,
      }),
    ).toEqual({ state: 'unknown', uploadReference: reference, reason: 'ambiguous' });
  });
  it('submits once with non-strict Hebrew/English hints and no translation', async () => {
    const value = setup((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        model: config.model,
        file_id: fileId,
        client_reference_id: reference,
        language_hints: ['he', 'en'],
        language_hints_strict: false,
        enable_language_identification: true,
        enable_speaker_diarization: true,
      });
      return json(providerJob, 201);
    });
    const result = await value.runtime.submit(
      ctx,
      { fileId, clientReference: reference },
      admitted,
    );
    expect(result).toMatchObject({
      state: 'submitted',
      job: { jobId, audioSeconds: 12, status: 'completed' },
    });
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    500, 502, 408,
  ])('treats uncertain POST HTTP %s as unknown, never retries', async (status) => {
    const value = setup(() => json({ message: 'private provider body' }, status));
    expect(
      await value.runtime.submit(ctx, { fileId, clientReference: reference }, admitted),
    ).toEqual({ state: 'unknown', reason: 'outcome_unknown' });
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    400, 401, 402, 429,
  ])('preserves known refusal HTTP %s without leaking raw details', async (status) => {
    const value = setup(() => json({ message: 'private provider body' }, status));
    await expect(
      value.runtime.submit(ctx, { fileId, clientReference: reference }, admitted),
    ).rejects.toThrow('provider operation failed');
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });
  it('reconciles all pages and requires exact file/model/reference/window', async () => {
    const value = setup((url) =>
      json({
        transcriptions: url.searchParams.get('cursor')
          ? [providerJob]
          : [{ ...providerJob, id: otherId, file_id: otherId }],
        next_page_cursor: url.searchParams.get('cursor') ? null : 'page-two',
      }),
    );
    expect(
      await value.runtime.reconcileSubmit(ctx, {
        fileId,
        clientReference: reference,
        ...window,
      }),
    ).toMatchObject({ state: 'submitted', job: { jobId } });
    expect(value.fetcher).toHaveBeenCalledTimes(2);
  });
  it('deduplicates repeated identical job IDs across pages', async () => {
    const value = setup((url) =>
      json({
        transcriptions: [providerJob],
        next_page_cursor: url.searchParams.get('cursor') ? null : 'page-two',
      }),
    );
    expect(
      (
        await value.runtime.reconcileSubmit(ctx, {
          fileId,
          clientReference: reference,
          ...window,
        })
      ).state,
    ).toBe('submitted');
  });
  it.each(['none', 'two', 'limit'])('does not resubmit when reconciliation is %s', async (mode) => {
    const value = setup(() =>
      json({
        transcriptions:
          mode === 'none'
            ? []
            : mode === 'two'
              ? [providerJob, { ...providerJob, id: otherId }]
              : [providerJob],
        next_page_cursor: mode === 'limit' ? 'repeated' : null,
      }),
    );
    expect(
      await value.runtime.reconcileSubmit(ctx, {
        fileId,
        clientReference: reference,
        ...window,
      }),
    ).toEqual({
      state: 'unknown',
      reason: mode === 'none' ? 'not_found' : mode === 'two' ? 'ambiguous' : 'page_limit',
    });
    expect(value.fetcher.mock.calls.every((row) => row[1]?.method === 'GET')).toBe(true);
  });
  it('preserves mixed-language transcript text, token spacing, milliseconds and speakers', async () => {
    const value = setup(() =>
      json({
        id: jobId,
        text: 'ממוצע mean 11',
        tokens: [
          {
            text: 'ממוצע',
            start_ms: 0,
            end_ms: 300,
            confidence: 0.9,
            language: 'he',
            speaker: '1',
          },
          {
            text: ' mean 11',
            start_ms: 310,
            end_ms: 1200,
            confidence: 0.8,
            language: 'en',
            speaker: '1',
          },
        ],
      }),
    );
    expect(await value.runtime.getTranscript(ctx, { jobId })).toEqual({
      text: 'ממוצע mean 11',
      tokens: [
        { text: 'ממוצע', startMs: 0, endMs: 300, confidence: 0.9, language: 'he', speaker: '1' },
        {
          text: ' mean 11',
          startMs: 310,
          endMs: 1200,
          confidence: 0.8,
          language: 'en',
          speaker: '1',
        },
      ],
    });
  });
  it('represents silence without fabricating tokens or errors', async () => {
    const value = setup(() => json({ id: jobId, text: '', tokens: [] }));
    expect(await value.runtime.getTranscript(ctx, { jobId })).toEqual({ text: '', tokens: [] });
  });
  it.each([
    'reversed',
    'untimed',
    'translated',
    'oversized',
    'wrong-id',
  ])('rejects %s output rather than silently modifying text', async (mode) => {
    const token = {
      text: 'hello',
      start_ms: 100,
      end_ms: mode === 'reversed' ? 0 : 300,
      confidence: 0.9,
      ...(mode === 'translated' ? { translation_status: 'translation' } : {}),
    };
    const value = setup(() =>
      json({
        id: mode === 'wrong-id' ? otherId : jobId,
        text: mode === 'oversized' ? 'א'.repeat(600) : 'hello',
        tokens: [{ ...token, ...(mode === 'untimed' ? { start_ms: undefined } : {}) }],
      }),
    );
    await expect(value.runtime.getTranscript(ctx, { jobId })).rejects.toThrow();
  });
  it('maps failed jobs to sanitized categories without vendor message', async () => {
    const value = setup(() =>
      json({ ...providerJob, status: 'error', error_message: 'private filename' }),
    );
    const result = await value.runtime.getJob(ctx, { jobId });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'transcription_failed' });
    expect(JSON.stringify(result)).not.toContain('private filename');
  });
  it('gets exact actual usage with all three token quantities and fractional cost', async () => {
    const value = usageSetup(() => json({ usage_logs: [usage], next_page_cursor: null }));
    expect(await value.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'known',
      providerUsageId: jobId,
      audioSeconds: 12,
      inputAudioTokens: 100,
      inputTextTokens: 3,
      outputTextTokens: 7,
      costUsd: 0.000185,
    });
  });
  it('keeps unavailable usage unknown, and never substitutes duration pricing', async () => {
    const value = usageSetup(() => json({ usage_logs: [], next_page_cursor: null }));
    expect(await value.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'unknown',
      reason: 'not_found',
    });
  });
  it('rejects conflicting duplicate usage rows and mismatched job correlation', async () => {
    const value = usageSetup(() =>
      json({ usage_logs: [usage, { ...usage, input_audio_tokens: 999 }], next_page_cursor: null }),
    );
    expect(await value.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'unknown',
      reason: 'ambiguous',
    });
    const mismatch = usageSetup(() =>
      json({
        usage_logs: [{ ...usage, client_reference_id: 'wrong-reference' }],
        next_page_cursor: null,
      }),
    );
    expect(await mismatch.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'unknown',
      reason: 'ambiguous',
    });
  });
  it('maps processing-delete 409 to pending and leaves both identities for later cleanup', async () => {
    const value = setup(() => json({ message: 'processing' }, 409));
    expect(await value.runtime.deleteJob(ctx, { jobId })).toEqual({ state: 'pending' });
    expect(await value.runtime.deleteFile(ctx, { fileId })).toEqual({ state: 'pending' });
  });
  it('treats already-deleted 404 as completed cleanup and keeps failed cleanup retryable', async () => {
    const value = setup(() => json({}, 404));
    expect(await value.runtime.deleteJob(ctx, { jobId })).toEqual({ state: 'deleted' });
    expect(await value.runtime.deleteFile(ctx, { fileId })).toEqual({ state: 'deleted' });
    const failed = setup(() => json({}, 500));
    await expect(failed.runtime.deleteJob(ctx, { jobId })).rejects.toThrow(
      'provider operation failed',
    );
  });
  it('cancels before submission without an external request', async () => {
    const value = setup(() => json(providerJob));
    const controller = new AbortController();
    controller.abort();
    await expect(
      value.runtime.submit(
        ctx,
        { fileId, clientReference: reference },
        { ...admitted, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(value.fetcher).not.toHaveBeenCalled();
  });
  it('bounds pagination even if the provider repeats cursors forever', async () => {
    const value = usageSetup(() => json({ usage_logs: [usage], next_page_cursor: 'repeat' }));
    expect(await value.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'unknown',
      reason: 'page_limit',
    });
    expect(value.fetcher).toHaveBeenCalledTimes(3);
  });
  it('correlates a distinct billing UUID through a verified job and unique opaque reference', async () => {
    const value = usageSetup(() =>
      json({ usage_logs: [{ ...usage, uuid: otherId }], next_page_cursor: null }),
    );
    expect(await value.runtime.getUsage(ctx, usageInput)).toMatchObject({
      state: 'known',
      providerUsageId: otherId,
      inputAudioTokens: 100,
    });
  });
  it('refuses multiple billing rows even when one UUID equals the job ID', async () => {
    const value = usageSetup(() =>
      json({ usage_logs: [usage, { ...usage, uuid: otherId }], next_page_cursor: null }),
    );
    expect(await value.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'unknown',
      reason: 'ambiguous',
    });
  });
  it('does not search billing for an unowned reference or a processing job', async () => {
    for (const data of [
      { ...providerJob, client_reference_id: 'another-reference' },
      { ...providerJob, status: 'processing' },
    ]) {
      const value = setup(() => json(data));
      expect((await value.runtime.getUsage(ctx, usageInput)).state).toBe('unknown');
      expect(value.fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('cancels a blocked input stream without starting an upload', async () => {
    const value = setup(() => json(file));
    const controller = new AbortController();
    async function* blocked() {
      await new Promise(() => {});
      yield new Uint8Array(4);
    }
    const pending = value.runtime.upload(ctx, uploadInput(blocked()), {
      ...admitted,
      signal: controller.signal,
    });
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(value.fetcher).not.toHaveBeenCalled();
  });
  it('settles delayed measured billing after deletion using a trusted exact terminal receipt', async () => {
    const value = setup((url) =>
      url.pathname === `/v1/transcriptions/${jobId}`
        ? json({}, 404)
        : json({ usage_logs: [usage], next_page_cursor: null }),
    );
    const verifiedJob = {
      jobId,
      fileId,
      model: config.model,
      clientReference: reference,
      status: 'completed' as const,
      createdAt: file.created_at,
      audioSeconds: 12,
    };
    expect(await value.runtime.getUsage(ctx, { ...usageInput, fileId, verifiedJob })).toMatchObject(
      { state: 'known', costUsd: 0.000185, providerUsageId: jobId },
    );
    expect(await value.runtime.getUsage(ctx, usageInput)).toEqual({
      state: 'unknown',
      reason: 'not_found',
    });
  });
  it.each([
    'file',
    'job',
    'model',
    'reference',
    'time',
  ])('refuses a mismatched persisted %s identity after deletion', async (part) => {
    const value = setup(() => json({}, 404));
    const verifiedJob = {
      jobId: part === 'job' ? otherId : jobId,
      fileId: part === 'file' ? otherId : fileId,
      model: part === 'model' ? 'another-model' : config.model,
      clientReference: part === 'reference' ? 'another-reference-00001' : reference,
      status: 'completed' as const,
      createdAt: part === 'time' ? '2026-10-12T10:00:00Z' : file.created_at,
    };
    expect(await value.runtime.getUsage(ctx, { ...usageInput, fileId, verifiedJob })).toEqual({
      state: 'unknown',
      reason: 'ambiguous',
    });
    expect(value.fetcher).not.toHaveBeenCalled();
  });
  it('cross-checks the saved receipt while the live job still exists', async () => {
    const value = setup(() => json({ ...providerJob, file_id: otherId }));
    const verifiedJob = {
      jobId,
      fileId,
      model: config.model,
      clientReference: reference,
      status: 'completed' as const,
      createdAt: file.created_at,
    };
    expect(await value.runtime.getUsage(ctx, { ...usageInput, fileId, verifiedJob })).toEqual({
      state: 'unknown',
      reason: 'ambiguous',
    });
  });
  it('does not adopt multiple delayed bills or treat a provider failure as deletion', async () => {
    const verifiedJob = {
      jobId,
      fileId,
      model: config.model,
      clientReference: reference,
      status: 'completed' as const,
      createdAt: file.created_at,
    };
    const value = setup((url) =>
      url.pathname === `/v1/transcriptions/${jobId}`
        ? json({}, 404)
        : json({ usage_logs: [usage, { ...usage, uuid: otherId }], next_page_cursor: null }),
    );
    expect(await value.runtime.getUsage(ctx, { ...usageInput, fileId, verifiedJob })).toEqual({
      state: 'unknown',
      reason: 'ambiguous',
    });
    const unavailable = setup(() => json({}, 503));
    await expect(
      unavailable.runtime.getUsage(ctx, { ...usageInput, fileId, verifiedJob }),
    ).rejects.toThrow();
  });
  it('refuses an omitted/unknown region before HTTP', () => {
    expect(() => setup(() => json({}), { region: '' })).toThrow();
    expect(() => setup(() => json({}), { region: 'unknown' })).toThrow();
  });
});
