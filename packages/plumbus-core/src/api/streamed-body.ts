// ── Streamed capability answers ──
// A capability whose output schema is `streamedBodyOutput` answers with bytes, not a JSON body:
// its handler returns `streamedBody(source, { contentType, … })` and the route sends the source
// as the HTTP body while the client reads it. Nothing holds the whole answer in memory, so an
// answer larger than any JSON body (a V8 string tops out near 512 MiB) can be sent.
//
// Everything a capability route does before the handler still happens (authentication, access,
// `authorize`, the executor's audit row, the data-plane lease). The lease is given back when the
// response ends, so a source may keep reading through `ctx` of a query while it is sent.

import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { createErrorService } from '../errors/index.js';

/**
 * Marks a streamed body. `Symbol.for` so another copy of the framework (or `@plumbus/api`)
 * recognises it without importing this module.
 */
export const STREAMED_BODY_BRAND: unique symbol = Symbol.for('plumbus.streamedBody') as never;

/** The metadata key the output schema carries; generators read it to tell a streamed answer. */
export const STREAMED_BODY_SCHEMA_META = 'plumbusBody';

/** What `streamedBody` accepts as the bytes to send. */
export type StreamedBodySource = AsyncIterable<Uint8Array> | Readable;

export interface StreamedBodyOptions {
  /** `Content-Type` of the answer, e.g. `application/zip` or `application/pdf`. Required. */
  contentType: string;
  /**
   * Exact size in bytes, sent as `Content-Length`. When given, a source that yields more or
   * fewer bytes ends the response with an error instead of a silently different file.
   */
  contentLength?: number;
  /** Offered file name (`Content-Disposition`). Any Unicode; sent with an ASCII fallback. */
  fileName?: string;
  /** `attachment` (default when `fileName` is given) or `inline`. */
  disposition?: 'attachment' | 'inline';
}

/** A capability answer made of bytes. Build it with {@link streamedBody}. */
export interface StreamedBody {
  readonly [STREAMED_BODY_BRAND]: true;
  readonly source: StreamedBodySource;
  readonly contentType: string;
  readonly contentLength?: number;
  readonly fileName?: string;
  readonly disposition?: 'attachment' | 'inline';
}

// A media type is a structured format (RFC 9110 §8.3.1): type "/" subtype, then parameters.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_TYPE = new RegExp(
  `^${TOKEN}/${TOKEN}(\\s*;\\s*${TOKEN}=(${TOKEN}|"[^"\\\\\\x00-\\x1f\\x7f]*"))*$`,
);

/** Whether `text` holds a C0 control character or DEL (never allowed in a header value). */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const optionsSchema = z
  .object({
    contentType: z.string().max(255).regex(MEDIA_TYPE, 'contentType must be a media type'),
    contentLength: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !hasControlCharacter(name), 'fileName must not hold control characters')
      .optional(),
    disposition: z.enum(['attachment', 'inline']).optional(),
  })
  .strict();

function isSource(value: unknown): value is StreamedBodySource {
  if (value instanceof Readable) return true;
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * The answer of a capability declared with `output: streamedBodyOutput`: `source` is sent as the
 * HTTP body as it is read. A `Readable` or any async iterable of byte chunks (an async generator
 * works). If the client goes away, the source is destroyed (a generator's `finally` runs).
 */
export function streamedBody(
  source: StreamedBodySource,
  options: StreamedBodyOptions,
): StreamedBody {
  if (!isSource(source)) {
    throw createErrorService().validation(
      'streamedBody needs a Readable or an async iterable of byte chunks',
      { reason: 'streamed-body-source' },
    );
  }
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw createErrorService().validation('Invalid streamedBody options', {
      reason: 'streamed-body-options',
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.message),
    });
  }
  return Object.freeze({
    [STREAMED_BODY_BRAND]: true as const,
    source,
    ...parsed.data,
  });
}

/** Whether `value` is a {@link StreamedBody} (from any copy of the framework). */
export function isStreamedBody(value: unknown): value is StreamedBody {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<symbol, unknown>)[STREAMED_BODY_BRAND] === true &&
    isSource((value as { source?: unknown }).source)
  );
}

/**
 * Output schema of a capability that answers with bytes. Its handler returns
 * `streamedBody(…)`; anything else fails output validation. Such a capability cannot be an MCP
 * tool or require idempotency (a stream cannot be stored and replayed); `defineCapability`
 * refuses both.
 */
export const streamedBodyOutput: z.ZodType<StreamedBody> = z
  .custom<StreamedBody>((value) => isStreamedBody(value), {
    message: 'Expected a streamed body (streamedBody(…))',
  })
  .meta({ [STREAMED_BODY_SCHEMA_META]: 'stream' });

/** Whether a capability's output schema is {@link streamedBodyOutput} (by its metadata). */
export function isStreamedBodySchema(schema: unknown): boolean {
  const meta = (schema as { meta?: () => Record<string, unknown> | undefined } | null)?.meta;
  if (typeof meta !== 'function') return false;
  try {
    return meta.call(schema)?.[STREAMED_BODY_SCHEMA_META] === 'stream';
  } catch {
    return false;
  }
}

/** `Content-Disposition` with an ASCII fallback and the exact name in `filename*` (RFC 6266). */
export function contentDisposition(
  fileName: string | undefined,
  disposition: 'attachment' | 'inline' | undefined,
): string | undefined {
  if (fileName === undefined) return disposition;
  const kind = disposition ?? 'attachment';
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Thrown into the response when a source yields a different size than it declared. */
export class StreamedBodyLengthError extends Error {
  constructor(
    readonly declared: number,
    readonly sent: number,
  ) {
    super(`Streamed body declared ${declared} bytes and yielded ${sent}`);
    this.name = 'StreamedBodyLengthError';
  }
}

/** The source as a Readable that fails when it yields more or fewer bytes than declared. */
function sizedReadable(body: StreamedBody): Readable {
  const declared = body.contentLength;
  if (declared === undefined) {
    return body.source instanceof Readable ? body.source : Readable.from(body.source);
  }
  const source = body.source;
  const expected: number = declared;
  async function* counted(): AsyncGenerator<Uint8Array> {
    let sent = 0;
    for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sent += bytes.byteLength;
      if (sent > expected) throw new StreamedBodyLengthError(expected, sent);
      yield bytes;
    }
    if (sent !== expected) throw new StreamedBodyLengthError(expected, sent);
  }
  const readable = Readable.from(counted(), { objectMode: false });
  // A client that goes away destroys `readable`; take the caller's Readable down with it.
  if (source instanceof Readable) readable.once('close', () => source.destroy());
  return readable;
}

/**
 * Send `body` as the HTTP answer: status 200, its headers, then its bytes as they are read. An
 * error while reading ends the response abruptly (the client sees a broken transfer, never a
 * complete-looking file) and is reported through `onError`.
 */
export function sendStreamedBody(
  reply: FastifyReply,
  body: StreamedBody,
  onError?: (error: unknown) => void,
): FastifyReply {
  const readable = sizedReadable(body);
  readable.once('error', (error) => {
    try {
      onError?.(error);
    } catch {
      // A failing reporter must not change what happens to the response.
    }
  });
  reply
    .status(200)
    .header('content-type', body.contentType)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store');
  if (body.contentLength !== undefined) reply.header('content-length', String(body.contentLength));
  const disposition = contentDisposition(body.fileName, body.disposition);
  if (disposition !== undefined) reply.header('content-disposition', disposition);
  return reply.send(readable);
}
