// A capability with a `streamedUploadInput` field takes the HTTP body as raw bytes, read while
// the client sends them, after authentication, access and `authorize`.

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildGenerateOpenApiDocument } from '../../cli/commands/generate-openapi-from-zod.js';
import { defineCapability } from '../../define/defineCapability.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { RouteGeneratorConfig } from '../route-generator.js';
import { registerCapabilityRoute } from '../route-generator.js';
import { streamedBody, streamedBodyOutput } from '../streamed-body.js';
import {
  type StreamedUpload,
  streamedUpload,
  streamedUploadFieldOf,
  streamedUploadInput,
  UPLOAD_INPUT_HEADER,
} from '../streamed-upload.js';

const member = { userId: 'u1', roles: ['member'], scopes: [], provider: 'test', tenantId: 't1' };
const visitor = { userId: 'u2', roles: ['visitor'], scopes: [], provider: 'test', tenantId: 't1' };
const MiB = 1024 * 1024;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function receiptCapability(
  handler: (
    ctx: unknown,
    input: { invoiceId: string; token: string; file: StreamedUpload },
  ) => Promise<unknown>,
  options: { maxBytes?: number; contentTypes?: string[] } = {},
): CapabilityContract {
  return defineCapability({
    name: 'uploadReceipt',
    kind: 'action',
    domain: 'billing',
    description: 'Upload the scanned receipt of an invoice',
    input: z.object({
      invoiceId: z.string(),
      token: z.string(),
      file: streamedUploadInput({
        maxBytes: options.maxBytes ?? 512 * MiB,
        ...(options.contentTypes ? { contentTypes: options.contentTypes } : {}),
      }),
    }),
    output: z.object({ invoiceId: z.string(), bytes: z.number(), sha256: z.string() }),
    access: { roles: ['member'] },
    effects: { data: [], events: [], external: ['object-storage'], ai: false },
    handler: handler as never,
  } as never) as unknown as CapabilityContract;
}

/** A handler that hashes the upload chunk by chunk and reports the byte count. */
function hashing(peak?: { value: number }) {
  return vi.fn(async (_ctx: unknown, input: { invoiceId: string; file: StreamedUpload }) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const base = process.memoryUsage();
    for await (const chunk of input.file) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (peak) {
        const now = process.memoryUsage();
        peak.value = Math.max(
          peak.value,
          now.heapUsed + now.arrayBuffers - base.heapUsed - base.arrayBuffers,
        );
      }
    }
    return { invoiceId: input.invoiceId, bytes, sha256: hash.digest('hex') };
  });
}

async function serve(cap: CapabilityContract, auth = member) {
  const app = Fastify({ forceCloseConnections: true });
  apps.push(app);
  registerCapabilityRoute(app, cap, {
    db: {} as unknown as PostgresJsDatabase,
    authAdapter: { authenticate: vi.fn(async () => auth) },
    createDependencies: () =>
      ({
        auth,
        data: {},
        audit: { record: vi.fn(async () => undefined) },
        logger: {
          info() {},
          warn() {},
          debug() {},
          error(...a: unknown[]) {
            if (process.env.DBG) console.log('LOGERR', JSON.stringify(a).slice(0, 600));
          },
        },
      }) as never,
  } as unknown as RouteGeneratorConfig);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api/billing/upload-receipt`;
}

const fieldsHeader = (fields: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(fields)).toString('base64url');

function bodyOf(size: number, chunk = MiB): ReadableStream<Uint8Array> {
  const block = new Uint8Array(chunk).fill(5);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, size - sent);
      controller.enqueue(n === chunk ? block : block.subarray(0, n));
      sent += n;
    },
  });
}

describe('streamed uploads', () => {
  it('reads a 200 MiB body chunk by chunk without holding it', async () => {
    const peak = { value: 0 };
    const url = await serve(receiptCapability(hashing(peak)));
    const size = 200 * MiB;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'inv-1', token: 'secret-token' }),
      },
      body: bodyOf(size),
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { bytes: number; invoiceId: string } };
    expect(data).toMatchObject({ invoiceId: 'inv-1', bytes: size });
    expect(peak.value).toBeLessThan(64 * MiB);
  }, 60_000);

  it('takes the other fields from the query string too, and keeps a JSON body raw', async () => {
    const handler = hashing();
    const url = await serve(receiptCapability(handler));
    const body = JSON.stringify({ not: 'parsed' });
    const response = await fetch(`${url}?invoiceId=inv-2&token=t`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { bytes: number; sha256: string } };
    expect(data.bytes).toBe(Buffer.byteLength(body));
    expect(data.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('refuses a caller the access policy refuses without reading the body', async () => {
    const handler = hashing();
    const url = await serve(receiptCapability(handler), visitor);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'x', token: 't' }),
      },
      body: new Uint8Array(1024),
    });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 413 for a declared length over the limit before reading, and for a body that grows past it', async () => {
    const handler = hashing();
    const url = await serve(receiptCapability(handler, { maxBytes: 4 * MiB }));
    const declared = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'x', token: 't' }),
      },
      body: new Uint8Array(5 * MiB),
    });
    expect(declared.status).toBe(413);
    const streamed = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'x', token: 't' }),
      },
      body: bodyOf(6 * MiB, 256 * 1024),
      duplex: 'half',
    } as RequestInit).catch((error: unknown) => error);
    // Chunked: the server stops reading at the limit and answers 413 (the client may also see
    // the connection close while it is still sending).
    if (streamed instanceof Response) expect(streamed.status).toBe(413);
    else expect(String(streamed)).toMatch(/fetch failed|socket|closed|reset/i);
  });

  it('answers 415 for a content type the field does not take', async () => {
    const url = await serve(
      receiptCapability(hashing(), { contentTypes: ['application/pdf', 'image/png'] }),
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'x', token: 't' }),
      },
      body: 'hello',
    });
    expect(response.status).toBe(415);
    const ok = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'image/png; charset=binary',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'x', token: 't' }),
      },
      body: 'png',
    });
    expect(ok.status).toBe(200);
  });

  it('answers 400 for a malformed input header and for missing fields', async () => {
    const url = await serve(receiptCapability(hashing()));
    const malformed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', [UPLOAD_INPUT_HEADER]: 'not base64url!' },
      body: 'x',
    });
    expect(malformed.status).toBe(400);
    const missing = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        [UPLOAD_INPUT_HEADER]: fieldsHeader({ invoiceId: 'x' }),
      },
      body: 'x',
    });
    expect(missing.status).toBe(400);
  });

  it('reads a small upload whole with bytes(), once', async () => {
    const upload = streamedUpload(Readable.from([Buffer.from('ab'), Buffer.from('c')]), {
      contentType: 'text/plain',
    });
    expect((await upload.bytes()).toString()).toBe('abc');
    expect(upload.consumed).toBe(true);
    await expect(upload.bytes()).rejects.toThrow(/read once/);
  });
});

describe('defineCapability with an upload', () => {
  const base = {
    name: 'uploadFile',
    kind: 'action',
    domain: 'files',
    description: 'Upload a file',
    output: z.object({}),
    access: { roles: ['member'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({}),
  };
  const file = () => streamedUploadInput({ maxBytes: MiB });

  it('accepts one upload field on a POST action', () => {
    const cap = defineCapability({
      ...base,
      input: z.object({ id: z.string(), file: file() }),
    } as never);
    expect(streamedUploadFieldOf(cap.input)).toEqual({ field: 'file', options: { maxBytes: MiB } });
  });

  it('refuses two upload fields, GET, a job, MCP and required idempotency', () => {
    expect(() =>
      defineCapability({ ...base, input: z.object({ a: file(), b: file() }) } as never),
    ).toThrow(/at most one/);
    expect(() =>
      defineCapability({ ...base, kind: 'query', input: z.object({ file: file() }) } as never),
    ).toThrow(/method with a body/);
    expect(() =>
      defineCapability({ ...base, kind: 'job', input: z.object({ file: file() }) } as never),
    ).toThrow(/cannot take an upload/);
    expect(() =>
      defineCapability({ ...base, exposeAs: ['mcp'], input: z.object({ file: file() }) } as never),
    ).toThrow(/MCP/);
    expect(() =>
      defineCapability({
        ...base,
        exposeAs: ['api'],
        api: {
          operationId: 'uploadFile',
          method: 'POST',
          path: '/files',
          idempotency: { required: true, header: 'Idempotency-Key' },
        },
        input: z.object({ file: file() }),
      } as never),
    ).toThrow(/stored for replay/);
    expect(() => streamedUploadInput({ maxBytes: 0 })).toThrow(/Invalid streamedUploadInput/);
  });
});

describe('plumbus generate OpenAPI', () => {
  it('describes an upload as bytes plus fields, and a streamed answer as octet-stream', () => {
    const upload = defineCapability({
      name: 'uploadReceipt',
      kind: 'action',
      domain: 'billing',
      description: 'Upload a receipt',
      input: z.object({
        invoiceId: z.string(),
        file: streamedUploadInput({ maxBytes: MiB, contentTypes: ['application/pdf'] }),
      }),
      output: z.object({ ok: z.boolean() }),
      access: { roles: ['member'] },
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'uploadReceipt', method: 'POST', path: '/receipts' },
      handler: async () => ({ ok: true }),
    } as never) as unknown as CapabilityContract;
    const download = defineCapability({
      name: 'downloadReceipt',
      kind: 'query',
      domain: 'billing',
      description: 'Download a receipt',
      input: z.object({ invoiceId: z.string() }),
      output: streamedBodyOutput,
      access: { roles: ['member'] },
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'downloadReceipt', method: 'GET', path: '/receipts/one' },
      handler: async () => streamedBody(Readable.from([]), { contentType: 'application/pdf' }),
    } as never) as unknown as CapabilityContract;
    const doc = buildGenerateOpenApiDocument([upload, download]) as {
      paths: Record<string, Record<string, any>>;
    };
    const post = doc.paths['/api/billing/upload-receipt']?.post;
    expect(post.requestBody.content).toEqual({
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    });
    expect(post.parameters.map((p: { in: string; name: string }) => `${p.in}:${p.name}`)).toEqual([
      'query:invoiceId',
      `header:${UPLOAD_INPUT_HEADER}`,
    ]);
    expect(post['x-plumbus-upload']).toEqual({ maxBytes: MiB });
    const get = doc.paths['/api/billing/download-receipt']?.get;
    expect(get.responses['200'].content).toEqual({
      'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
    });
    expect(JSON.stringify(get.responses['200'])).not.toContain('plumbusBody');
  });
});
