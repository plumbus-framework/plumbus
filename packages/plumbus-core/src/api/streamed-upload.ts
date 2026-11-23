// ── Streamed uploads ──
// A capability that takes a file declares one input field `streamedUploadInput({ maxBytes })`.
// Its route takes the HTTP request body as raw bytes (any content type, never parsed as JSON),
// and the handler receives that field as a `StreamedUpload`: an async iterable of the body's
// chunks, read while the client sends them. The other input fields come from the
// `x-plumbus-input` header (base64url JSON, so a secret never lands in a URL and its access log)
// or from the query string.
//
// Nothing is read before the capability's access policy and `authorize` passed: the size and
// content type are checked when the handler starts reading, and a body past `maxBytes` stops the
// read with HTTP 413.

import { z } from 'zod';
import { createErrorService } from '../errors/index.js';

/** Marks a streamed upload (`Symbol.for`, so another copy of the framework recognises it). */
export const STREAMED_UPLOAD_BRAND: unique symbol = Symbol.for('plumbus.streamedUpload') as never;

/** Schema metadata key of an upload field; generators read it. */
export const STREAMED_UPLOAD_SCHEMA_META = 'plumbusUpload';

/** The header carrying an upload request's other input fields (base64url of their JSON). */
export const UPLOAD_INPUT_HEADER = 'x-plumbus-input';

export interface StreamedUploadOptions {
  /** Most bytes the body may have (required; at most 64 GiB). Past it the read fails with 413. */
  maxBytes: number;
  /**
   * Media types the body may declare (`Content-Type`, compared without parameters, case
   * insensitive). Omitted: any. Another type fails the read with 415.
   */
  contentTypes?: string[];
}

/** An upload's bytes as the handler receives them. Read it once. */
export interface StreamedUpload extends AsyncIterable<Uint8Array> {
  readonly [STREAMED_UPLOAD_BRAND]: true;
  /** The request's `Content-Type` (with parameters), or `application/octet-stream`. */
  readonly contentType: string;
  /** The declared `Content-Length`, when the client sent one. */
  readonly contentLength?: number;
  /** Read the whole body into one buffer (for a small upload; `maxBytes` still applies). */
  bytes(): Promise<Buffer>;
}

const MAX_UPLOAD_BYTES = 64 * 1024 ** 3;
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const optionsSchema = z
  .object({
    maxBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    contentTypes: z.array(z.string().regex(MEDIA_TYPE).max(255)).min(1).optional(),
  })
  .strict();

/** Whether `value` is a {@link StreamedUpload}. */
export function isStreamedUpload(value: unknown): value is StreamedUpload {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<symbol, unknown>)[STREAMED_UPLOAD_BRAND] === true
  );
}

/**
 * The schema of an input field that receives the request body as a {@link StreamedUpload}.
 * A capability has at most one; its route is a POST/PUT/PATCH whose body is the raw bytes.
 */
export function streamedUploadInput(options: StreamedUploadOptions): z.ZodType<StreamedUpload> {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw createErrorService().validation('Invalid streamedUploadInput options', {
      reason: 'streamed-upload-options',
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.message),
    });
  }
  return z
    .custom<StreamedUpload>((value) => isStreamedUpload(value), {
      message: 'Expected an uploaded body',
    })
    .meta({ [STREAMED_UPLOAD_SCHEMA_META]: { ...parsed.data } });
}

/** The upload field of an input schema and its options, or `undefined`. */
export function streamedUploadFieldOf(
  inputSchema: unknown,
): { field: string; options: StreamedUploadOptions } | undefined {
  const shape = objectShapeOf(inputSchema);
  if (!shape) return undefined;
  for (const [field, schema] of Object.entries(shape)) {
    const options = uploadOptionsOf(schema);
    if (options) return { field, options };
  }
  return undefined;
}

/** Every upload field of an input schema (`defineCapability` refuses more than one). */
export function streamedUploadFieldsOf(inputSchema: unknown): string[] {
  const shape = objectShapeOf(inputSchema);
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([, schema]) => uploadOptionsOf(schema) !== undefined)
    .map(([field]) => field);
}

function objectShapeOf(schema: unknown): Record<string, unknown> | undefined {
  const shape = (schema as { shape?: unknown } | null)?.shape;
  return shape && typeof shape === 'object' ? (shape as Record<string, unknown>) : undefined;
}

function uploadOptionsOf(schema: unknown): StreamedUploadOptions | undefined {
  const meta = (schema as { meta?: () => Record<string, unknown> | undefined } | null)?.meta;
  if (typeof meta !== 'function') return undefined;
  try {
    const value = meta.call(schema)?.[STREAMED_UPLOAD_SCHEMA_META];
    return value && typeof value === 'object' ? (value as StreamedUploadOptions) : undefined;
  } catch {
    return undefined;
  }
}

function refusal(status: 413 | 415, reason: string, message: string) {
  return createErrorService().validation(message, { reason, httpStatus: status });
}

/**
 * A {@link StreamedUpload} over `source`, enforcing `maxBytes` and `contentTypes` when read.
 * Routes build one from the request; tests and in-process callers can build one from any byte
 * source (`streamedUpload(Readable.from([buffer]), { contentType: 'application/pdf' })`).
 */
export function streamedUpload(
  source: AsyncIterable<Uint8Array | string>,
  options: {
    contentType?: string;
    contentLength?: number;
    maxBytes?: number;
    contentTypes?: string[];
  } = {},
): StreamedUpload & { readonly consumed: boolean } {
  const contentType = options.contentType?.trim() || 'application/octet-stream';
  let started = false;
  let finished = false;

  async function* read(): AsyncGenerator<Uint8Array> {
    if (started) {
      throw createErrorService().validation('An upload can be read once', {
        reason: 'upload-read-twice',
      });
    }
    started = true;
    const media = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (options.contentTypes && !options.contentTypes.some((t) => t.toLowerCase() === media)) {
      throw refusal(415, 'upload-content-type', `Uploads of type "${media}" are not accepted`);
    }
    const limit = options.maxBytes;
    if (
      limit !== undefined &&
      options.contentLength !== undefined &&
      options.contentLength > limit
    ) {
      throw refusal(413, 'upload-too-large', `The upload is larger than ${limit} bytes`);
    }
    let seen = 0;
    for await (const chunk of source) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      seen += bytes.byteLength;
      if (limit !== undefined && seen > limit) {
        throw refusal(413, 'upload-too-large', `The upload is larger than ${limit} bytes`);
      }
      yield bytes;
    }
    finished = true;
  }

  const upload = {
    [STREAMED_UPLOAD_BRAND]: true as const,
    contentType,
    ...(options.contentLength !== undefined ? { contentLength: options.contentLength } : {}),
    [Symbol.asyncIterator]: () => read(),
    async bytes(): Promise<Buffer> {
      const parts: Uint8Array[] = [];
      for await (const part of read()) parts.push(part);
      return Buffer.concat(parts);
    },
    get consumed(): boolean {
      return finished;
    },
    toJSON: () => ({ contentType, contentLength: options.contentLength }),
  };
  return upload as StreamedUpload & { readonly consumed: boolean };
}

/**
 * The non-upload input fields of an upload request: the JSON in `x-plumbus-input`
 * (base64url) when present, else `fromQuery()`. A malformed header is a 400.
 */
export function uploadRequestFields(
  header: string | string[] | undefined,
  fromQuery: () => Record<string, unknown>,
): Record<string, unknown> {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw === '') return fromQuery();
  if (raw.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw createErrorService().validation(`${UPLOAD_INPUT_HEADER} must be base64url JSON`, {
      reason: 'upload-input-header',
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw createErrorService().validation(`${UPLOAD_INPUT_HEADER} must be base64url JSON`, {
      reason: 'upload-input-header',
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw createErrorService().validation(`${UPLOAD_INPUT_HEADER} must hold a JSON object`, {
      reason: 'upload-input-header',
    });
  }
  return value as Record<string, unknown>;
}
