// What `resolveDependencies` holds for a request (a data-plane lease) is given back once the
// response has ended — on a real Fastify reply, however the request ends.

import Fastify from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PlumbusError } from '../../errors/plumbus-error.js';
import type { CapabilityContract } from '../../types/capability.js';
import { ErrorCode } from '../../types/enums.js';
import type { RouteGeneratorConfig } from '../route-generator.js';
import { registerCapabilityRoute } from '../route-generator.js';

const auth = { userId: 'u1', roles: ['member'], scopes: [], provider: 'test', tenantId: 't1' };
const tenantDb = { name: 'tenant' } as unknown as PostgresJsDatabase;
const dependencies = () => ({ auth, data: {}, audit: { record: vi.fn(async () => {}) } }) as never;

function capability(handler: () => Promise<unknown>): CapabilityContract {
  return {
    name: 'lookup',
    kind: 'query',
    domain: 'catalog',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['member'] },
    handler,
  } as unknown as CapabilityContract;
}

async function serve(
  cap: CapabilityContract,
  resolveDependencies: RouteGeneratorConfig['resolveDependencies'],
) {
  const app = Fastify();
  registerCapabilityRoute(app, cap, {
    db: { name: 'boot' } as unknown as PostgresJsDatabase,
    authAdapter: { authenticate: vi.fn(async () => auth) },
    createDependencies: vi.fn(() => ({ auth, data: {} })),
    resolveDependencies,
  } as unknown as RouteGeneratorConfig);
  await app.ready();
  return app;
}

describe('request dependency release', () => {
  it('releases once, after the response is sent', async () => {
    const release = vi.fn();
    let releasedBeforeHandlerFinished = false;
    const app = await serve(
      capability(async () => {
        releasedBeforeHandlerFinished = release.mock.calls.length > 0;
        return { ok: true };
      }),
      vi.fn(async () => ({ dependencies: dependencies(), db: tenantDb, release })),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/lookup',
      headers: { authorization: 'Bearer t' },
    });
    expect(response.statusCode, response.body).toBeLessThan(500);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(releasedBeforeHandlerFinished).toBe(false);
    await app.close();
  });

  it('releases when the capability fails too', async () => {
    const release = vi.fn();
    const app = await serve(
      capability(async () => {
        throw new PlumbusError(ErrorCode.Conflict, 'nope');
      }),
      vi.fn(async () => ({ dependencies: dependencies(), db: tenantDb, release })),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/lookup',
      headers: { authorization: 'Bearer t' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it('answers 503 when no data-plane slot is free', async () => {
    const { DataPlaneCapacityError } = await import('../../tenancy/data-plane-resolver.js');
    const app = await serve(
      capability(async () => ({ ok: true })),
      vi.fn(async () => {
        throw new DataPlaneCapacityError('t1', { cacheSize: 2, leases: 2, waitedMs: 10 });
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/lookup',
      headers: { authorization: 'Bearer t' },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
