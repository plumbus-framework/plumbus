// ── The optional `resolveDependencies` seam ──
//
// `createDependencies` stays the only path when no resolver is configured.
// When one is, it decides the request's dependencies *and* the database the
// work outside the execution context addresses — queue dispatch and the
// capability error hook — and a refusal from it fails the request rather than
// falling through to another database.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PlumbusError } from '../../errors/plumbus-error.js';
import type { CapabilityContract } from '../../types/capability.js';
import { ErrorCode } from '../../types/enums.js';

const dispatchQueuedJob = vi.fn(async () => 'job-1');
vi.mock('../../jobs/dispatch.js', () => ({
  dispatchQueuedJob: (...args: unknown[]) => dispatchQueuedJob(...(args as [])),
}));

import type { RouteGeneratorConfig } from '../route-generator.js';
import { registerCapabilityRoute } from '../route-generator.js';

// ── Helpers ──

const bootDb = { name: 'boot' } as unknown as PostgresJsDatabase;
const tenantDb = { name: 'tenant' } as unknown as PostgresJsDatabase;

const jobCapability = {
  name: 'reindex',
  kind: 'job',
  domain: 'catalog',
  input: z.object({ target: z.string() }),
  output: z.object({ jobId: z.string() }),
  effects: { data: [], events: [], external: [], ai: false },
  access: { roles: ['member'] },
  handler: async () => ({ jobId: 'unused' }),
} as unknown as CapabilityContract;

const auth = {
  userId: 'u1',
  roles: ['member'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-1',
};

function makeConfig(overrides: Partial<RouteGeneratorConfig> = {}): RouteGeneratorConfig {
  return {
    db: bootDb,
    authAdapter: { authenticate: vi.fn(async () => auth) },
    createDependencies: vi.fn(() => ({ auth, data: {} })),
    jobQueue: { publish: vi.fn(async () => {}), subscribe: vi.fn(), close: vi.fn(async () => {}) },
    ...overrides,
  } as unknown as RouteGeneratorConfig;
}

function makeApp() {
  const handlers = new Map<string, (request: unknown, reply: unknown) => Promise<void>>();
  return {
    get: vi.fn((path: string, handler: never) => handlers.set(path, handler)),
    post: vi.fn((path: string, handler: never) => handlers.set(path, handler)),
    handlerFor: (path: string) => {
      const handler = handlers.get(path);
      if (!handler) throw new Error(`No handler registered for ${path}`);
      return handler;
    },
  };
}

function makeReply() {
  const sent: { statusCode?: number; body?: any } = {};
  const reply = {
    status: vi.fn((code: number) => {
      sent.statusCode = code;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      sent.body = body;
      return reply;
    }),
    header: vi.fn(() => reply),
    sent,
  };
  return reply;
}

async function callRoute(config: RouteGeneratorConfig) {
  const app = makeApp();
  registerCapabilityRoute(app as never, jobCapability, config);
  const reply = makeReply();
  await app.handlerFor('/api/catalog/reindex')(
    { headers: { authorization: 'Bearer t' }, body: { target: 'x' }, ip: '127.0.0.1' },
    reply,
  );
  return reply.sent;
}

// ── Tests ──

describe('resolveDependencies', () => {
  it('is not consulted, and nothing extra is awaited, when it is absent', async () => {
    const config = makeConfig();
    const sent = await callRoute(config);

    expect(config.createDependencies).toHaveBeenCalledTimes(1);
    expect(sent.statusCode).toBe(202);
    expect(dispatchQueuedJob).toHaveBeenCalledWith(expect.objectContaining({ db: bootDb }));
  });

  it('replaces the synchronous factory and routes queue dispatch to the resolved database', async () => {
    dispatchQueuedJob.mockClear();
    const config = makeConfig({
      resolveDependencies: vi.fn(async () => ({
        dependencies: { auth, data: {} } as never,
        db: tenantDb,
      })),
    });

    const sent = await callRoute(config);

    expect(config.createDependencies).not.toHaveBeenCalled();
    expect(config.resolveDependencies).toHaveBeenCalledTimes(1);
    expect(sent.statusCode).toBe(202);
    expect(dispatchQueuedJob).toHaveBeenCalledWith(expect.objectContaining({ db: tenantDb }));
  });

  it('maps a PlumbusError refusal to its own status and code', async () => {
    dispatchQueuedJob.mockClear();
    const config = makeConfig({
      resolveDependencies: vi.fn(async () => {
        throw new PlumbusError(ErrorCode.Forbidden, 'the request carries no tenant reference');
      }),
    });

    const sent = await callRoute(config);

    expect(sent.statusCode).toBe(403);
    expect(sent.body.error.code).toBe('forbidden');
    expect(sent.body.error.message).toContain('no tenant reference');
    expect(dispatchQueuedJob).not.toHaveBeenCalled();
  });

  it('never echoes an infrastructure failure back to the caller', async () => {
    dispatchQueuedJob.mockClear();
    const config = makeConfig({
      resolveDependencies: vi.fn(async () => {
        throw new Error('postgres://user:secret@10.0.0.7/tenant_9 is unreachable');
      }),
    });

    const sent = await callRoute(config);

    expect(sent.statusCode).toBe(500);
    expect(sent.body.error.code).toBe('internal');
    expect(sent.body.error.message).not.toContain('secret');
    expect(dispatchQueuedJob).not.toHaveBeenCalled();
  });
});
