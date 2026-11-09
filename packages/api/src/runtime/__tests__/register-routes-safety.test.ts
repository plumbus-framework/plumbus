import { defineCapability, type RouteGeneratorConfig } from '@plumbus/core';
import {
  createTestAuth,
  mockAI,
  mockAudit,
  mockEvents,
  mockFlows,
  mockLogger,
} from '@plumbus/core/testing';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiManifestError } from '../../errors.js';
import { createInMemoryIdempotencyStore } from '../idempotency.js';
import { registerApiRoutes, resetIdempotencyWarningForTests } from '../register-routes.js';

function buildRouteConfig(): RouteGeneratorConfig {
  return {
    db: {} as RouteGeneratorConfig['db'],
    authAdapter: {
      authenticate: async (header) =>
        header ? createTestAuth({ roles: ['admin'], scopes: [] }) : null,
    },
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

function actionCap(method: 'GET' | 'POST', onRun: () => void, idempotent = false) {
  return defineCapability({
    name: 'deleteWidget',
    kind: 'action',
    domain: 'widgets',
    input: z.object({ widgetId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    exposeAs: ['api'],
    api: {
      operationId: 'deleteWidget',
      method,
      path: '/widgets/{widgetId}/delete',
      ...(idempotent ? { idempotency: { required: true, header: 'Idempotency-Key' } } : {}),
    },
    handler: async () => {
      onRun();
      return { deleted: true };
    },
  });
}

const queryCap = defineCapability({
  name: 'getWidget',
  kind: 'query',
  domain: 'widgets',
  input: z.object({ widgetId: z.string() }),
  output: z.object({ widgetId: z.string() }),
  effects: { data: [], events: [], external: [], ai: false },
  access: { roles: ['admin'] },
  exposeAs: ['api'],
  api: { operationId: 'getWidget', method: 'GET', path: '/widgets/{widgetId}' },
  handler: async (_ctx, input) => ({ widgetId: input.widgetId }),
});

describe('registerApiRoutes — actions over GET', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
  });

  it('registers a GET action by default but logs a CSRF warning naming the route', async () => {
    let ran = false;
    app = Fastify();
    const warn = vi.spyOn(app.log, 'warn');
    registerApiRoutes(app, buildRouteConfig(), [
      actionCap('GET', () => {
        ran = true;
      }),
      queryCap,
    ]);
    await app.ready();

    expect(warn).toHaveBeenCalledTimes(1);
    const [details, message] = warn.mock.calls[0] as unknown as [{ routes: string[] }, string];
    expect(details.routes).toEqual([
      'GET /api/v1/widgets/{widgetId}/delete (widgets.deleteWidget, deleteWidget)',
    ]);
    expect(message).toContain('CSRF');
    expect(message).toContain('rejectActionsOverGet');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/widgets/w1/delete',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    expect(ran).toBe(true);
  });

  it('does not warn for queries over GET or actions over POST', async () => {
    app = Fastify();
    const warn = vi.spyOn(app.log, 'warn');
    registerApiRoutes(app, buildRouteConfig(), [actionCap('POST', () => {}), queryCap]);
    await app.ready();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejectActionsOverGet: true refuses to register the GET action', async () => {
    app = Fastify();
    let thrown: unknown;
    try {
      registerApiRoutes(app, buildRouteConfig(), [actionCap('GET', () => {}), queryCap], {
        rejectActionsOverGet: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiManifestError);
    expect((thrown as ApiManifestError).code).toBe('api.register.action-over-get');
    expect((thrown as ApiManifestError).message).toContain('widgets.deleteWidget');

    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/widgets/w1/delete',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejectActionsOverGet: true still registers POST actions and GET queries', async () => {
    app = Fastify();
    registerApiRoutes(app, buildRouteConfig(), [actionCap('POST', () => {}), queryCap], {
      rejectActionsOverGet: true,
    });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/widgets/w1',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('registerApiRoutes — default in-memory idempotency store in production', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    resetIdempotencyWarningForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  function idempotencyWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
    return warn.mock.calls.filter((call: unknown[]) =>
      String(call[1]).includes('in-memory idempotency store'),
    );
  }

  it('warns once in production when idempotent routes use the default store', async () => {
    vi.stubEnv('PLUMBUS_ENV', '');
    vi.stubEnv('NODE_ENV', 'production');
    app = Fastify();
    const warn = vi.spyOn(app.log, 'warn');
    registerApiRoutes(app, buildRouteConfig(), [actionCap('POST', () => {}, true)]);
    expect(idempotencyWarnings(warn)).toHaveLength(1);
    expect(String(idempotencyWarnings(warn)[0]?.[1])).toContain('idempotencyStore');

    const second = Fastify();
    const warn2 = vi.spyOn(second.log, 'warn');
    registerApiRoutes(second, buildRouteConfig(), [actionCap('POST', () => {}, true)]);
    expect(idempotencyWarnings(warn2)).toHaveLength(0);
    await second.close();
  });

  it('does not warn when a store is passed, outside production, or without idempotent routes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLUMBUS_ENV', '');
    app = Fastify();
    const warn = vi.spyOn(app.log, 'warn');
    registerApiRoutes(app, buildRouteConfig(), [actionCap('POST', () => {}, true)], {
      idempotencyStore: createInMemoryIdempotencyStore(),
    });
    registerApiRoutes(Fastify(), buildRouteConfig(), [actionCap('POST', () => {})]);
    expect(idempotencyWarnings(warn)).toHaveLength(0);

    vi.stubEnv('NODE_ENV', 'development');
    const dev = Fastify();
    const warnDev = vi.spyOn(dev.log, 'warn');
    registerApiRoutes(dev, buildRouteConfig(), [actionCap('POST', () => {}, true)]);
    expect(idempotencyWarnings(warnDev)).toHaveLength(0);
    await dev.close();
  });
});
