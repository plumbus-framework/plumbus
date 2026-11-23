// A capability declared with `output: streamedBodyOutput` answers with bytes: the route sends
// the handler's source while the client reads it, after the same authentication, access check
// and audit row as any capability.

import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../define/defineCapability.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { RouteGeneratorConfig } from '../route-generator.js';
import { registerCapabilityRoute } from '../route-generator.js';
import {
  contentDisposition,
  isStreamedBody,
  isStreamedBodySchema,
  streamedBody,
  streamedBodyOutput,
} from '../streamed-body.js';

const member = { userId: 'u1', roles: ['member'], scopes: [], provider: 'test', tenantId: 't1' };
const outsider = { userId: 'u2', roles: ['visitor'], scopes: [], provider: 'test', tenantId: 't1' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function reportCapability(
  handler: CapabilityContract['handler'],
  extra: Partial<Parameters<typeof defineCapability>[0]> = {},
): CapabilityContract {
  return defineCapability({
    name: 'downloadReport',
    kind: 'query',
    domain: 'reports',
    description: 'Download a report file',
    input: z.object({ reportId: z.string() }),
    output: streamedBodyOutput,
    access: { roles: ['member'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: handler as never,
    ...extra,
  } as never) as unknown as CapabilityContract;
}

async function serve(cap: CapabilityContract, auth = member) {
  const audit: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const errors: string[] = [];
  // Close idle keep-alive sockets of the test client on close.
  const app = Fastify({ forceCloseConnections: true });
  apps.push(app);
  registerCapabilityRoute(app, cap, {
    db: {} as unknown as PostgresJsDatabase,
    authAdapter: { authenticate: vi.fn(async () => auth) },
    createDependencies: () =>
      ({
        auth,
        data: {},
        audit: {
          record: vi.fn(async (action: string, metadata?: Record<string, unknown>) => {
            audit.push({ action, metadata });
          }),
        },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          debug: () => undefined,
          error: (message: string) => {
            errors.push(message);
          },
        },
      }) as never,
  } as unknown as RouteGeneratorConfig);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/reports/download-report?reportId=r1`, audit, errors };
}

function chunk(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

describe('streamed capability answers', () => {
  it('sends bytes while the client reads them: chunk 2 is produced only after chunk 1 arrived', async () => {
    let firstArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      firstArrived = resolve;
    });
    const produced: number[] = [];
    const cap = reportCapability(async () =>
      streamedBody(
        (async function* () {
          produced.push(1);
          yield chunk(64 * 1024, 1);
          // A server that buffered the whole answer before sending would wait here forever:
          // the client cannot see chunk 1 until it is sent.
          await arrived;
          produced.push(2);
          yield chunk(64 * 1024, 2);
        })(),
        { contentType: 'application/octet-stream' },
      ),
    );
    const { url } = await serve(cap);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    let received = 0;
    let signalled = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!signalled && received >= 64 * 1024) {
        expect(produced).toEqual([1]);
        signalled = true;
        firstArrived();
      }
    }
    expect(received).toBe(128 * 1024);
    expect(produced).toEqual([1, 2]);
  });

  it('sends an answer larger than any JSON string (640 MiB) without holding it in memory', async () => {
    const MiB = 1024 * 1024;
    const total = 640 * MiB; // V8 strings stop near 512 MiB: no JSON body could carry this.
    const block = chunk(MiB, 9);
    const cap = reportCapability(async () =>
      streamedBody(
        (async function* () {
          for (let sent = 0; sent < total; sent += MiB) yield block;
        })(),
        { contentType: 'application/octet-stream', contentLength: total },
      ),
    );
    const { url } = await serve(cap);
    const memory = () => {
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const baseline = memory();
    let peak = baseline;
    const response = await fetch(url);
    expect(response.headers.get('content-length')).toBe(String(total));
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      peak = Math.max(peak, memory());
    }
    expect(received).toBe(total);
    // Client and server share this process; both together stay far below the answer's size.
    expect(peak - baseline).toBeLessThan(128 * MiB);
  }, 60_000);

  it('sends its headers: type, length, file name with an ASCII fallback, nosniff, no-store', async () => {
    const bytes = Buffer.from('id,total\n1,10\n');
    const cap = reportCapability(async () =>
      streamedBody(Readable.from([bytes]), {
        contentType: 'text/csv; charset=utf-8',
        contentLength: bytes.byteLength,
        fileName: 'invoices é 2026.csv',
      }),
    );
    const { url, audit } = await serve(cap);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="invoices _ 2026.csv"; filename*=UTF-8''invoices%20%C3%A9%202026.csv`,
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    // The executor's audit row of a successful call is written as for any capability.
    expect(audit.map((row) => row.action)).toContain('capability.reports.downloadReport');
  });

  it('refuses a caller the access policy refuses, before the handler runs', async () => {
    const handler = vi.fn(async () =>
      streamedBody(Readable.from([Buffer.from('x')]), { contentType: 'text/plain' }),
    );
    const { url } = await serve(reportCapability(handler), outsider);
    const response = await fetch(url);
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(handler).not.toHaveBeenCalled();
  });

  it('breaks the transfer when the source yields fewer bytes than it declared', async () => {
    const cap = reportCapability(async () =>
      streamedBody(Readable.from([Buffer.from('short')]), {
        contentType: 'application/octet-stream',
        contentLength: 1000,
      }),
    );
    const { url, errors } = await serve(cap);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(() => expect(errors.join('\n')).toContain('streamed answer failed'));
  });

  it('breaks the transfer when the source fails half way (never a complete-looking file)', async () => {
    const cap = reportCapability(async () =>
      streamedBody(
        (async function* () {
          yield chunk(1024, 7);
          throw new Error('object store went away');
        })(),
        { contentType: 'application/octet-stream' },
      ),
    );
    const { url, errors } = await serve(cap);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(() => expect(errors.join('\n')).toContain('streamed answer failed'));
  });

  it('stops the source when the client goes away', async () => {
    let finished = false;
    let yielded = 0;
    const cap = reportCapability(async () =>
      streamedBody(
        (async function* () {
          try {
            for (;;) {
              yielded += 1;
              yield chunk(64 * 1024, 3);
            }
          } finally {
            finished = true;
          }
        })(),
        { contentType: 'application/octet-stream' },
      ),
    );
    const { url } = await serve(cap);
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5_000 });
    expect(yielded).toBeLessThan(10_000);
  });

  it('answers 500 when the handler of a streamed capability returns something else', async () => {
    const cap = reportCapability(async () => ({ not: 'a stream' }) as never);
    const { url } = await serve(cap);
    const response = await fetch(url);
    expect(response.status).toBe(500);
  });
});

describe('streamedBody and the output schema', () => {
  it('validates its options as structured formats', () => {
    const source = Readable.from([]);
    expect(() => streamedBody(source, { contentType: 'text/plain\r\nset-cookie: a=b' })).toThrow(
      /Invalid streamedBody options/,
    );
    expect(() => streamedBody(source, { contentType: 'not a type' })).toThrow();
    expect(() =>
      streamedBody(source, { contentType: 'text/plain', fileName: 'a\nb.txt' }),
    ).toThrow();
    expect(() => streamedBody(source, { contentType: 'text/plain', contentLength: -1 })).toThrow();
    expect(() => streamedBody('bytes' as never, { contentType: 'text/plain' })).toThrow(
      /Readable or an async iterable/,
    );
    const body = streamedBody(source, { contentType: 'application/pdf' });
    expect(isStreamedBody(body)).toBe(true);
    expect(isStreamedBody({ source })).toBe(false);
    expect(Object.isFrozen(body)).toBe(true);
  });

  it('marks the schema so generators can tell a streamed answer', () => {
    expect(isStreamedBodySchema(streamedBodyOutput)).toBe(true);
    expect(isStreamedBodySchema(z.object({}))).toBe(false);
    expect(isStreamedBodySchema(z.unknown())).toBe(false);
  });

  it('builds content-disposition without letting a name break the header', () => {
    expect(contentDisposition(undefined, undefined)).toBeUndefined();
    expect(contentDisposition(undefined, 'inline')).toBe('inline');
    expect(contentDisposition('a"b\\c.txt', 'inline')).toBe(
      `inline; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`,
    );
  });
});

describe('defineCapability with a streamed answer', () => {
  const base = {
    name: 'exportFile',
    domain: 'reports',
    description: 'Export a file',
    input: z.object({}),
    output: streamedBodyOutput,
    access: { roles: ['member'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => streamedBody(Readable.from([]), { contentType: 'text/plain' }),
  };

  it('accepts a query and an action', () => {
    expect(() => defineCapability({ ...base, kind: 'query' } as never)).not.toThrow();
    expect(() => defineCapability({ ...base, kind: 'action' } as never)).not.toThrow();
  });

  it('refuses a job, an event handler, MCP exposure and required idempotency', () => {
    expect(() => defineCapability({ ...base, kind: 'job' } as never)).toThrow(/streamed body/);
    expect(() => defineCapability({ ...base, kind: 'eventHandler' } as never)).toThrow(
      /streamed body/,
    );
    expect(() => defineCapability({ ...base, kind: 'query', exposeAs: ['mcp'] } as never)).toThrow(
      /MCP/,
    );
    expect(() =>
      defineCapability({
        ...base,
        kind: 'action',
        exposeAs: ['api'],
        api: {
          operationId: 'exportFile',
          method: 'POST',
          path: '/reports/export',
          idempotency: { required: true, header: 'Idempotency-Key' },
        },
      } as never),
    ).toThrow(/stored for replay/);
  });
});
