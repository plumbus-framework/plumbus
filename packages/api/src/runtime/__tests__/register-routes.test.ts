import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineCapability, type RouteGeneratorConfig } from '@plumbus/core';
import {
  createTestAuth,
  mockAudit,
  mockEvents,
  mockFlows,
  mockLogger,
  mockAI,
} from '@plumbus/core/testing';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiManifest } from '../../manifest/types.js';
import { createInMemoryIdempotencyStore } from '../idempotency.js';
import { registerApiRoutes } from '../register-routes.js';

function buildRouteConfig(audit = mockAudit()): RouteGeneratorConfig {
  return {
    db: {} as RouteGeneratorConfig['db'],
    authAdapter: {
      authenticate: async (header) => {
        if (!header) {
          return null;
        }
        return createTestAuth({ roles: ['admin'], scopes: ['refunds:read'] });
      },
    },
    createDependencies: (auth) => ({
      auth,
      data: {} as never,
      events: mockEvents(),
      flows: mockFlows(),
      ai: mockAI(),
      audit,
      logger: mockLogger(),
      config: {},
    }),
  };
}

const manifest: ApiManifest = {
  apiVersion: 'plumbus.dev/v1',
  name: 'test-api',
  basePath: '/api/v1',
  expose: [
    {
      capability: 'billing.getRefund',
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
    },
    {
      capability: 'billing.approveRefund',
      operationId: 'approveRefund',
      method: 'POST',
      path: '/refunds/{refundId}/approve',
      idempotency: { required: true, header: 'Idempotency-Key' },
      test: { enabled: true, modes: ['validate-only', 'safe-reply'], defaultMode: 'safe-reply' },
    },
  ],
};

describe('registerApiRoutes', () => {
  let app: ReturnType<typeof Fastify>;
  let handlerExecuted = false;
  let tmpDir: string;

  afterEach(async () => {
    handlerExecuted = false;
    if (app) {
      await app.close();
    }
  });

  async function setupCaps(fixturePath?: string) {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    if (fixturePath) {
      await mkdir(join(tmpDir, 'fixtures'), { recursive: true });
      await writeFile(
        join(tmpDir, fixturePath),
        JSON.stringify({ refundId: '123', status: 'approved' }),
      );
    }

    const getRefund = defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'getRefund',
        method: 'GET',
        path: '/refunds/{refundId}',
      },
      handler: async (_ctx, input) => {
        handlerExecuted = true;
        return { refundId: input.refundId, status: 'live' };
      },
    });

    const approveRefund = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
        test: {
          enabled: true,
          modes: ['validate-only', 'safe-reply'],
          defaultMode: 'safe-reply',
          safeReply: fixturePath ? { fixture: fixturePath } : undefined,
        },
      },
      handler: async (_ctx, input) => {
        handlerExecuted = true;
        return { refundId: input.refundId, status: 'approved-live' };
      },
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [getRefund, approveRefund], {
      manifest,
      appRoot: tmpDir,
      idempotencyStore: createInMemoryIdempotencyStore(),
    });
    await app.ready();

    return { getRefund, approveRefund };
  }

  it('live request returns success envelope', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('live');
    expect(body.meta.requestId).toBeDefined();
    expect(handlerExecuted).toBe(true);
  });

  it('path param merges into input', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/from-path',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.json().data.refundId).toBe('from-path');
  });

  it('coerces numeric GET query parameters', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    let receivedLimit: number | undefined;
    const listRefunds = defineCapability({
      name: 'listRefunds',
      kind: 'query',
      domain: 'billing',
      input: z.object({ limit: z.number() }),
      output: z.object({ items: z.array(z.string()) }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: { operationId: 'listRefunds', method: 'GET', path: '/refunds' },
      handler: async (_ctx, input) => {
        receivedLimit = input.limit;
        return { items: ['a'] };
      },
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [listRefunds], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.listRefunds',
            operationId: 'listRefunds',
            method: 'GET',
            path: '/refunds',
          },
        ],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds?limit=25',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedLimit).toBe(25);
  });

  it('missing auth returns 401 unauthenticated envelope', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthenticated');
  });

  it('invalid auth header returns 401 unauthenticated', async () => {
    const routeConfig: RouteGeneratorConfig = {
      ...buildRouteConfig(),
      authAdapter: {
        authenticate: async (header) => (header ? null : null),
      },
    };
    await setupCaps();
    app = Fastify();
    const caps = [
      defineCapability({
        name: 'getRefund',
        kind: 'query',
        domain: 'billing',
        input: z.object({ refundId: z.string() }),
        output: z.object({ refundId: z.string(), status: z.string() }),
        effects: { data: [], events: [], external: [], ai: false },
        access: { roles: ['admin'] },
        exposeAs: ['api'],
        api: { operationId: 'getRefund', method: 'GET', path: '/refunds/{refundId}' },
        handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'live' }),
      }),
    ];
    registerApiRoutes(app, routeConfig, caps, { manifest, appRoot: tmpDir });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { authorization: 'Bearer bad' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('authenticated but forbidden role returns 403', async () => {
    const routeConfig: RouteGeneratorConfig = {
      ...buildRouteConfig(),
      authAdapter: {
        authenticate: async () => createTestAuth({ roles: ['guest'], scopes: [] }),
      },
    };
    await setupCaps();
    app = Fastify();
    const caps = [
      defineCapability({
        name: 'getRefund',
        kind: 'query',
        domain: 'billing',
        input: z.object({ refundId: z.string() }),
        output: z.object({ refundId: z.string(), status: z.string() }),
        effects: { data: [], events: [], external: [], ai: false },
        access: { roles: ['admin'] },
        exposeAs: ['api'],
        api: { operationId: 'getRefund', method: 'GET', path: '/refunds/{refundId}' },
        handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'live' }),
      }),
    ];
    registerApiRoutes(app, routeConfig, caps, { manifest, appRoot: tmpDir });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('test intent disabled returns test_intent_not_supported', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: {
        authorization: 'Bearer test',
        'x-plumbus-intent': 'test',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('test_intent_not_supported');
  });

  it('validate-only does not execute handler', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: {
        authorization: 'Bearer test',
        'x-plumbus-intent': 'test',
        'x-plumbus-test-mode': 'validate-only',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('validate-only');
    expect(res.json().data.valid).toBe(true);
    expect(handlerExecuted).toBe(false);
  });

  it('safe-reply returns fixture without executing handler', async () => {
    await setupCaps('fixtures/approve.json');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: {
        authorization: 'Bearer test',
        'x-plumbus-intent': 'test',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('approved');
    expect(handlerExecuted).toBe(false);
  });

  it('safe-reply rejects schema-mismatched fixture', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(join(tmpDir, 'fixtures'), { recursive: true });
    await writeFile(join(tmpDir, 'fixtures/bad.json'), JSON.stringify({ wrong: true }));

    const approveRefund = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
        test: {
          enabled: true,
          modes: ['safe-reply'],
          safeReply: { fixture: 'fixtures/bad.json' },
        },
      },
      handler: async () => ({ refundId: 'x', status: 'y' }),
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [approveRefund], {
      manifest: {
        ...manifest,
        expose: [manifest.expose[1] as (typeof manifest.expose)[0]],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: {
        authorization: 'Bearer test',
        'x-plumbus-intent': 'test',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal_error');
  });

  it('missing required idempotency header → validation_failed', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: { authorization: 'Bearer test' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('missing api scope returns 403 missing_scope', async () => {
    const routeConfig: RouteGeneratorConfig = {
      ...buildRouteConfig(),
      authAdapter: {
        authenticate: async () => createTestAuth({ roles: ['admin'], scopes: [] }),
      },
    };
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const cap = defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'getRefund',
        method: 'GET',
        path: '/refunds/{refundId}',
        auth: { scopes: ['refunds:read'] },
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'live' }),
    });

    app = Fastify();
    registerApiRoutes(app, routeConfig, [cap], { manifest, appRoot: tmpDir });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('missing_scope');
  });

  it('explicit tenantId in query returns tenant_boundary_violation', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const cap = defineCapability({
      name: 'listRefunds',
      kind: 'query',
      domain: 'billing',
      input: z.object({ tenantId: z.string().optional(), limit: z.number().optional() }),
      output: z.object({ items: z.array(z.string()) }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: { operationId: 'listRefunds', method: 'GET', path: '/refunds' },
      handler: async () => ({ items: [] }),
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [cap], {
      manifest: {
        ...manifest,
        policy: { tenantRouting: { mode: 'auth-context', forbidExplicitTenantInput: true } },
        expose: [
          {
            capability: 'billing.listRefunds',
            operationId: 'listRefunds',
            method: 'GET',
            path: '/refunds',
          },
        ],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds?tenantId=explicit',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_boundary_violation');
  });

  it('test intent without auth returns 401', async () => {
    await setupCaps();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: { 'x-plumbus-intent': 'test' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('manifest test override disables inline test', async () => {
    await setupCaps('fixtures/approve.json');
    const capWithInlineTest = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
        test: {
          enabled: true,
          modes: ['safe-reply'],
          safeReply: { fixture: 'fixtures/approve.json' },
        },
      },
      handler: async () => ({ refundId: 'x', status: 'live' }),
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [capWithInlineTest], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            test: { enabled: false, modes: ['validate-only'] },
          },
        ],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: { authorization: 'Bearer test', 'x-plumbus-intent': 'test' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('test_intent_not_supported');
  });

  it('missing fixture returns structured envelope not raw 500', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
        test: {
          enabled: true,
          modes: ['safe-reply'],
          safeReply: { fixture: 'fixtures/missing.json' },
        },
      },
      handler: async () => ({ refundId: 'x', status: 'y' }),
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            test: {
              enabled: true,
              modes: ['safe-reply'],
              safeReply: { fixture: 'fixtures/missing.json' },
            },
          },
        ],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: { authorization: 'Bearer test', 'x-plumbus-intent': 'test' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe('not_found');
  });

  it('idempotency scopes key by operation and principal', async () => {
    await setupCaps();
    const store = createInMemoryIdempotencyStore();
    let callCount = 0;
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: { operationId: 'approveRefund', method: 'POST', path: '/refunds/{refundId}/approve' },
      handler: async (_ctx, input) => {
        callCount += 1;
        return { refundId: input.refundId, status: `call-${callCount}` };
      },
    });

    const routeConfigA: RouteGeneratorConfig = {
      ...buildRouteConfig(),
      authAdapter: {
        authenticate: async () =>
          createTestAuth({
            userId: 'user-a',
            tenantId: 'tenant-a',
            roles: ['admin'],
            scopes: ['refunds:read'],
          }),
      },
    };
    const routeConfigB: RouteGeneratorConfig = {
      ...buildRouteConfig(),
      authAdapter: {
        authenticate: async () =>
          createTestAuth({
            userId: 'user-b',
            tenantId: 'tenant-b',
            roles: ['admin'],
            scopes: ['refunds:read'],
          }),
      },
    };

    app = Fastify();
    registerApiRoutes(app, routeConfigA, [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            idempotency: { required: true, header: 'Idempotency-Key' },
          },
        ],
      },
      idempotencyStore: store,
    });
    await app.ready();

    const headers = { authorization: 'Bearer a', 'idempotency-key': 'shared-key' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers,
      payload: {},
    });
    expect(first.json().data.status).toBe('call-1');

    await app.close();
    app = Fastify();
    registerApiRoutes(app, routeConfigB, [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            idempotency: { required: true, header: 'Idempotency-Key' },
          },
        ],
      },
      idempotencyStore: store,
    });
    await app.ready();

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: { authorization: 'Bearer b', 'idempotency-key': 'shared-key' },
      payload: {},
    });
    expect(second.json().data.status).toBe('call-2');
  });

  it('in-memory store returns same result for same key', async () => {
    await setupCaps();
    const store = createInMemoryIdempotencyStore();
    app = Fastify();
    const caps = [
      defineCapability({
        name: 'approveRefund',
        kind: 'action',
        domain: 'billing',
        input: z.object({ refundId: z.string() }),
        output: z.object({ refundId: z.string(), status: z.string() }),
        effects: { data: [], events: [], external: [], ai: false },
        access: { roles: ['admin'] },
        exposeAs: ['api'],
        api: {
          operationId: 'approveRefund',
          method: 'POST',
          path: '/refunds/{refundId}/approve',
        },
        handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'once' }),
      }),
    ];
    registerApiRoutes(app, buildRouteConfig(), caps, {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            idempotency: { required: true, header: 'Idempotency-Key' },
          },
        ],
      },
      idempotencyStore: store,
    });
    await app.ready();

    const headers = {
      authorization: 'Bearer test',
      'idempotency-key': 'key-1',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers,
      payload: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers,
      payload: {},
    });
    expect(first.json().data).toEqual(second.json().data);
  });

  it('rejects escaped safe-reply fixture paths at runtime', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
        test: {
          enabled: true,
          modes: ['safe-reply'],
          safeReply: { fixture: '../outside.json' },
        },
      },
      handler: async () => ({ refundId: 'x', status: 'y' }),
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            test: {
              enabled: true,
              modes: ['safe-reply'],
              safeReply: { fixture: '../outside.json' },
            },
          },
        ],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/approve',
      headers: { authorization: 'Bearer test', 'x-plumbus-intent': 'test' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).not.toContain('../outside.json');
  });

  it('concurrent duplicate receives error when first idempotent request fails', async () => {
    await setupCaps();
    const store = createInMemoryIdempotencyStore();
    let callCount = 0;
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: { operationId: 'approveRefund', method: 'POST', path: '/refunds/{refundId}/approve' },
      handler: async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 50));
        throw new Error('handler failed');
      },
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            idempotency: { required: true, header: 'Idempotency-Key' },
          },
        ],
      },
      idempotencyStore: store,
    });
    await app.ready();

    const headers = {
      authorization: 'Bearer test',
      'idempotency-key': 'fail-key',
    };
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/refunds/r1/approve',
        headers,
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/refunds/r1/approve',
        headers,
        payload: {},
      }),
    ]);

    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(first.json().ok).toBe(false);
    expect(second.json().ok).toBe(false);
    expect(callCount).toBe(2);
  });

  it('public endpoint with required idempotency rejects anonymous principal', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const store = createInMemoryIdempotencyStore();
    let callCount = 0;
    const cap = defineCapability({
      name: 'publicApprove',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { public: true },
      exposeAs: ['api'],
      api: {
        operationId: 'publicApprove',
        method: 'POST',
        path: '/refunds/{refundId}/public-approve',
      },
      handler: async (_ctx, input) => {
        callCount += 1;
        return { refundId: input.refundId, status: `call-${callCount}` };
      },
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.publicApprove',
            operationId: 'publicApprove',
            method: 'POST',
            path: '/refunds/{refundId}/public-approve',
            idempotency: { required: true, header: 'Idempotency-Key' },
          },
        ],
      },
      appRoot: tmpDir,
      idempotencyStore: store,
    });
    await app.ready();

    const headers = { 'idempotency-key': 'anon-key' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/public-approve',
      headers,
      payload: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/refunds/r1/public-approve',
      headers,
      payload: {},
    });

    expect(first.statusCode).toBe(401);
    expect(first.json().error.code).toBe('unauthenticated');
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('unauthenticated');
    expect(callCount).toBe(0);
  });

  it('public capability with test enabled rejects test intent at runtime', async () => {
    tmpDir = join(tmpdir(), `plumbus-api-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const cap = defineCapability({
      name: 'publicPing',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { public: true },
      exposeAs: ['api'],
      api: {
        operationId: 'publicPing',
        method: 'GET',
        path: '/public-ping',
        test: { enabled: true, modes: ['validate-only'] },
      },
      handler: async () => ({ ok: true }),
    });

    const routeConfig: RouteGeneratorConfig = {
      ...buildRouteConfig(),
      authAdapter: {
        authenticate: async () =>
          createTestAuth({ userId: 'synthetic-user', roles: [], scopes: [] }),
      },
    };

    app = Fastify();
    registerApiRoutes(app, routeConfig, [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.publicPing',
            operationId: 'publicPing',
            method: 'GET',
            path: '/public-ping',
            test: { enabled: true, modes: ['validate-only'] },
          },
        ],
      },
      appRoot: tmpDir,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public-ping',
      headers: {
        authorization: 'Bearer test',
        'x-plumbus-intent': 'test',
        'x-plumbus-test-mode': 'validate-only',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('test_intent_not_supported');
    expect(res.json().error.message).toContain('public');
  });

  it('concurrent idempotent POSTs execute handler only once', async () => {
    await setupCaps();
    const store = createInMemoryIdempotencyStore();
    let callCount = 0;
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      exposeAs: ['api'],
      api: { operationId: 'approveRefund', method: 'POST', path: '/refunds/{refundId}/approve' },
      handler: async (_ctx, input) => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 50));
        return { refundId: input.refundId, status: `call-${callCount}` };
      },
    });

    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [cap], {
      manifest: {
        ...manifest,
        expose: [
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
            idempotency: { required: true, header: 'Idempotency-Key' },
          },
        ],
      },
      idempotencyStore: store,
    });
    await app.ready();

    const headers = {
      authorization: 'Bearer test',
      'idempotency-key': 'concurrent-key',
    };
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/refunds/r1/approve',
        headers,
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/refunds/r1/approve',
        headers,
        payload: {},
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().data).toEqual(second.json().data);
    expect(callCount).toBe(1);
  });
});

describe('registerApiRoutes requestAuthenticator', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  function buildSessionRouteConfig(
    authenticator: NonNullable<RouteGeneratorConfig['requestAuthenticator']>,
    authAdapter = {
      authenticate: async () => {
        throw new Error('authAdapter should not be called when requestAuthenticator is set');
      },
    },
  ): RouteGeneratorConfig {
    return {
      db: {} as RouteGeneratorConfig['db'],
      authAdapter,
      requestAuthenticator: authenticator,
      createDependencies: (auth) => ({
        auth,
        data: {} as never,
        events: mockEvents(),
        flows: mockFlows(),
        ai: mockAI(),
        audit: mockAudit(),
        logger: mockLogger(),
        config: {},
      }),
    };
  }

  async function mountGetRefund(routeConfig: RouteGeneratorConfig) {
    const getRefund = defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({
        refundId: z.string(),
        userId: z.string().optional(),
        tenantId: z.string().optional(),
      }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'], scopes: ['refunds:read'], tenantScoped: true },
      exposeAs: ['api'],
      api: {
        operationId: 'getRefund',
        method: 'GET',
        path: '/refunds/{refundId}',
      },
      handler: async (ctx, input) => ({
        refundId: input.refundId,
        userId: ctx.auth.userId,
        tenantId: ctx.auth.tenantId,
      }),
    });

    app = Fastify();
    registerApiRoutes(app, routeConfig, [getRefund], {
      manifest: {
        apiVersion: 'plumbus.dev/v1',
        name: 'test-api',
        basePath: '/api/v1',
        expose: [
          {
            capability: 'billing.getRefund',
            operationId: 'getRefund',
            method: 'GET',
            path: '/refunds/{refundId}',
          },
        ],
      },
    });
    await app.ready();
  }

  it('authenticates cookie session via requestAuthenticator into ctx.auth', async () => {
    await mountGetRefund(
      buildSessionRouteConfig({
        authenticate: async () => ({
          status: 'authenticated',
          auth: createTestAuth({
            userId: 'session-user',
            roles: ['admin'],
            scopes: ['refunds:read'],
            tenantId: 'tenant-42',
            provider: 'oidc',
          }),
        }),
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { cookie: 'session=abc', 'x-csrf-token': 'csrf' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      refundId: 'r1',
      userId: 'session-user',
      tenantId: 'tenant-42',
    });
  });

  it('returns 401 unauthenticated for anonymous session on protected partner route', async () => {
    await mountGetRefund(
      buildSessionRouteConfig({
        authenticate: async () => ({ status: 'anonymous' }),
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v1/refunds/r1' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('returns 403 csrf_failed from requestAuthenticator', async () => {
    await mountGetRefund(
      buildSessionRouteConfig({
        authenticate: async () => ({ status: 'invalid', code: 'csrf_failed' }),
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { cookie: 'session=abc' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('returns 503 authentication_unavailable from requestAuthenticator', async () => {
    await mountGetRefund(
      buildSessionRouteConfig({
        authenticate: async () => ({
          status: 'unavailable',
          code: 'authentication_unavailable',
        }),
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v1/refunds/r1' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('authentication_unavailable');
  });

  it('keeps JWT authAdapter path when requestAuthenticator is undefined', async () => {
    await mountGetRefund(buildRouteConfig());
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('does not share anonymous auth arrays across public requests', async () => {
    const seen: Array<{
      auth: { roles: string[] };
      roles: string[];
      rolesAtEntry: string[];
      mutationRejected: boolean;
    }> = [];
    const publicCap = defineCapability({
      name: 'ping',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { public: true },
      exposeAs: ['api'],
      api: { operationId: 'ping', method: 'GET', path: '/ping' },
      handler: async (ctx) => {
        // Each request must get its own auth object *and* its own roles array —
        // a shared array would leak one caller's roles into the next request.
        // The sealed context also rejects the write outright, so the attempt is
        // recorded rather than allowed to fail the request.
        let mutationRejected = false;
        try {
          ctx.auth.roles.push('mutated');
        } catch (err) {
          mutationRejected = err instanceof TypeError;
        }
        seen.push({
          auth: ctx.auth,
          roles: ctx.auth.roles,
          rolesAtEntry: [...ctx.auth.roles],
          mutationRejected,
        });
        return { ok: true };
      },
    });

    app = Fastify();
    registerApiRoutes(
      app,
      buildSessionRouteConfig({
        authenticate: async () => ({ status: 'anonymous' }),
      }),
      [publicCap],
      {
        manifest: {
          apiVersion: 'plumbus.dev/v1',
          name: 'test-api',
          basePath: '/api/v1',
          expose: [
            {
              capability: 'billing.ping',
              operationId: 'ping',
              method: 'GET',
              path: '/ping',
            },
          ],
        },
      },
    );
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.auth).not.toBe(seen[1]?.auth);
    // The property under test: the roles arrays are distinct objects, so
    // nothing one request does to its own array can reach the next one.
    expect(seen[0]?.roles).not.toBe(seen[1]?.roles);
    expect(seen[0]?.rolesAtEntry).toEqual([]);
    expect(seen[1]?.rolesAtEntry).toEqual([]);
    // Sealed context: the elevation attempt threw and left both arrays empty.
    expect(seen[0]?.mutationRejected).toBe(true);
    expect(seen[1]?.mutationRejected).toBe(true);
    expect(seen[0]?.auth.roles).toEqual([]);
    expect(seen[1]?.auth.roles).toEqual([]);
  });

  it('returns 401 for invalid bearer under requestAuthenticator (Bearer fails closed)', async () => {
    await mountGetRefund(
      buildSessionRouteConfig({
        authenticate: async () => ({ status: 'invalid', code: 'invalid_authorization' }),
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/refunds/r1',
      headers: { authorization: 'Bearer bad-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('sets Set-Cookie clear header on anonymous result that carries clearCookieHeader', async () => {
    await mountGetRefund(
      buildSessionRouteConfig({
        authenticate: async () => ({
          status: 'anonymous',
          clearCookieHeader: 'plumbus_session=; HttpOnly; Path=/; Max-Age=0',
        }),
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v1/refunds/r1' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBe('plumbus_session=; HttpOnly; Path=/; Max-Age=0');
  });

  it('public route with requestAuthenticator returning invalid credentials returns 401', async () => {
    const publicCap = defineCapability({
      name: 'ping',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { public: true },
      exposeAs: ['api'],
      api: { operationId: 'ping', method: 'GET', path: '/ping' },
      handler: async () => ({ ok: true }),
    });

    app = Fastify();
    registerApiRoutes(
      app,
      buildSessionRouteConfig({
        authenticate: async () => ({ status: 'invalid', code: 'invalid_authorization' }),
      }),
      [publicCap],
      {
        manifest: {
          apiVersion: 'plumbus.dev/v1',
          name: 'test-api',
          basePath: '/api/v1',
          expose: [
            {
              capability: 'billing.ping',
              operationId: 'ping',
              method: 'GET',
              path: '/ping',
            },
          ],
        },
      },
    );
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      headers: { authorization: 'Bearer bad-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });
});
