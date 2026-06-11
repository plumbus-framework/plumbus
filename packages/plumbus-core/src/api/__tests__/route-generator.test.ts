import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import {
  registerAllRoutes,
  registerCapabilityRoute,
  registerStreamingRoute,
} from '../route-generator.js';

// ── Helpers ──

function makeCapability(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'getUser',
    kind: 'query',
    domain: 'users',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
    effects: { data: ['User'], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler: async (_ctx, input) => ({
      id: input.id,
      name: 'Test User',
    }),
    ...overrides,
  } as CapabilityContract;
}

function makeMockApp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
  };
}

function makeMockConfig() {
  return {
    db: {
      execute: vi.fn(),
    } as unknown as PostgresJsDatabase,
    authAdapter: {
      authenticate: vi.fn().mockResolvedValue({
        userId: 'u1',
        roles: ['admin'],
        scopes: [],
        provider: 'test',
        tenantId: 'tenant-1',
      }),
    },
    createDependencies: vi.fn().mockReturnValue({
      auth: {
        userId: 'u1',
        roles: ['admin'],
        scopes: [],
        provider: 'test',
        tenantId: 'tenant-1',
      },
      data: {},
    }),
  };
}

function makeMockRequest(query: Record<string, string> = {}, body?: Record<string, unknown>) {
  return {
    headers: { authorization: 'Bearer test-token' },
    query,
    body,
    ip: '127.0.0.1',
  };
}

function makeMockReply() {
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

// ── Tests ──

describe('registerCapabilityRoute', () => {
  it('registers a GET route for query capabilities', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({ kind: 'query' });

    registerCapabilityRoute(app as any, cap, config);

    expect(app.get).toHaveBeenCalledTimes(1);
    expect(app.post).not.toHaveBeenCalled();
    expect(app.get.mock.calls[0]?.[0]).toBe('/api/users/get-user');
  });

  it('registers a POST route for action capabilities', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({ kind: 'action', name: 'createUser' });

    registerCapabilityRoute(app as any, cap, config);

    expect(app.post).toHaveBeenCalledTimes(1);
    expect(app.get).not.toHaveBeenCalled();
    expect(app.post.mock.calls[0]?.[0]).toBe('/api/users/create-user');
  });

  it('registers a POST route for job capabilities', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({ kind: 'job', name: 'processReport' });

    registerCapabilityRoute(app as any, cap, config);

    expect(app.post).toHaveBeenCalledTimes(1);
    expect(app.post.mock.calls[0]?.[0]).toBe('/api/users/process-report');
  });

  it('registers snake_case capability names as kebab-case paths', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({
      kind: 'action',
      name: 'create_install_enrollment',
      domain: 'identity',
    });

    registerCapabilityRoute(app as any, cap, config);

    expect(app.post).toHaveBeenCalledTimes(1);
    expect(app.post.mock.calls[0]?.[0]).toBe('/api/identity/create-install-enrollment');
  });

  it('skips eventHandler capabilities', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({ kind: 'eventHandler', name: 'onUserCreated' });

    registerCapabilityRoute(app as any, cap, config);

    expect(app.get).not.toHaveBeenCalled();
    expect(app.post).not.toHaveBeenCalled();
  });
});

describe('job capability with jobQueue', () => {
  function makeJobSetup(
    authRoles: string[] = ['admin'],
    auth: { userId?: string; roles: string[] } | null = { userId: 'u1', roles: authRoles },
  ) {
    const publish = vi.fn().mockResolvedValue(undefined);
    const authContext =
      auth === null
        ? { userId: undefined, roles: [], scopes: [], provider: 'anonymous' as const }
        : {
            userId: auth.userId ?? 'u1',
            roles: auth.roles,
            scopes: [],
            provider: 'test' as const,
            tenantId: 'tenant-1',
          };
    const config = {
      ...makeMockConfig(),
      db: {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: 'job-test-id',
                capabilityDomain: 'users',
                capabilityName: 'processReport',
                status: 'queued',
              },
            ]),
          }),
        }),
      } as unknown as PostgresJsDatabase,
      authAdapter: {
        authenticate: vi.fn().mockResolvedValue(auth === null ? null : authContext),
      },
      jobQueue: { publish },
      createDependencies: vi.fn().mockReturnValue({
        auth: authContext,
        data: {},
      }),
    };
    const cap = makeCapability({
      kind: 'job',
      name: 'processReport',
      input: z.object({ reportId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      access: { roles: ['admin'] },
      handler: async () => ({ ok: true }),
    });
    const app = makeMockApp();
    registerCapabilityRoute(app as any, cap, config as any);
    const handler = app.post.mock.calls[0]?.[1];
    return { handler, publish, cap };
  }

  it('returns 403 and does not publish when unauthorized', async () => {
    const { handler, publish } = makeJobSetup(['viewer']);
    const reply = makeMockReply();
    await handler(makeMockRequest({}, { reportId: 'r1' }), reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns 403 and does not publish for unauthenticated callers', async () => {
    const { handler, publish } = makeJobSetup(['admin'], null);
    const reply = makeMockReply();
    await handler(makeMockRequest({}, { reportId: 'r1' }), reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns 400 and does not publish when input is invalid', async () => {
    const { handler, publish } = makeJobSetup();
    const reply = makeMockReply();
    await handler(makeMockRequest({}, {}), reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns 202 and publishes when authorized with valid input', async () => {
    const { handler, publish } = makeJobSetup();
    const reply = makeMockReply();
    await handler(makeMockRequest({}, { reportId: 'r1' }), reply);
    expect(reply.status).toHaveBeenCalledWith(202);
    expect(publish).toHaveBeenCalledTimes(1);
    const envelope = publish.mock.calls[0]?.[0];
    expect(envelope?.payload?.input).toEqual({ reportId: 'r1' });
    expect(envelope?.payload?.jobExecutionId).toBeDefined();
    expect(envelope?.payload?.auth).toBeUndefined();
  });
});

describe('registerStreamingRoute', () => {
  function makeStreamingSetup(
    authRoles: string[] = ['admin'],
    auth: { userId?: string; roles: string[] } | null = { userId: 'u1', roles: authRoles },
  ) {
    const written: string[] = [];
    const reply = {
      raw: {
        writeHead: vi.fn(),
        write: vi.fn((chunk: string) => {
          written.push(chunk);
        }),
        end: vi.fn(),
      },
    };
    const authContext =
      auth === null
        ? { userId: undefined, roles: [], scopes: [], provider: 'anonymous' as const }
        : {
            userId: auth.userId ?? 'u1',
            roles: auth.roles,
            scopes: [],
            provider: 'test' as const,
            tenantId: 'tenant-1',
          };
    const config = {
      ...makeMockConfig(),
      authAdapter: {
        authenticate: vi.fn().mockResolvedValue(auth === null ? null : authContext),
      },
      createDependencies: vi.fn().mockReturnValue({
        auth: authContext,
        data: {},
      }),
    };
    const cap = makeCapability({
      kind: 'action',
      name: 'streamChat',
      input: z.object({ prompt: z.string() }),
      output: z.object({ text: z.string() }),
      access: { roles: ['admin'] },
      handler: async () => ({ text: 'ok' }),
    });
    const streamHandler = vi.fn(async function* () {
      yield { type: 'token', content: 'hello' };
    });
    const app = makeMockApp();
    registerStreamingRoute(app as any, cap, config as any, streamHandler);
    const handler = app.post.mock.calls[0]?.[1];
    return { handler, reply, written, streamHandler };
  }

  it('emits a single error SSE event when unauthorized', async () => {
    const { handler, reply, written, streamHandler } = makeStreamingSetup(['viewer']);
    await handler(
      { headers: { authorization: 'Bearer t' }, body: { prompt: 'hi' }, ip: '127.0.0.1' },
      reply,
    );
    expect(streamHandler).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    const payload = JSON.parse(written[0]?.replace(/^data: /, '').trim() ?? '{}');
    expect(payload.type).toBe('error');
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('emits a single error SSE event when unauthenticated', async () => {
    const { handler, reply, written, streamHandler } = makeStreamingSetup(['admin'], null);
    await handler({ headers: {}, body: { prompt: 'hi' }, ip: '127.0.0.1' }, reply);
    expect(streamHandler).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    const payload = JSON.parse(written[0]?.replace(/^data: /, '').trim() ?? '{}');
    expect(payload.type).toBe('error');
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('emits a single error SSE event when input is invalid', async () => {
    const { handler, reply, written, streamHandler } = makeStreamingSetup();
    await handler({ headers: { authorization: 'Bearer t' }, body: {}, ip: '127.0.0.1' }, reply);
    expect(streamHandler).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    const payload = JSON.parse(written[0]?.replace(/^data: /, '').trim() ?? '{}');
    expect(payload.type).toBe('error');
    expect(payload.error?.code).toBe('validation');
    expect(reply.raw.end).toHaveBeenCalled();
  });
});

describe('registerAllRoutes', () => {
  it('registers routes for multiple capabilities', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const caps = [
      makeCapability({ kind: 'query', name: 'getUser' }),
      makeCapability({ kind: 'action', name: 'createUser' }),
      makeCapability({ kind: 'eventHandler', name: 'onUserCreated' }),
    ];

    registerAllRoutes(app as any, caps, config);

    expect(app.get).toHaveBeenCalledTimes(1);
    expect(app.post).toHaveBeenCalledTimes(1);
  });
});

describe('GET query param coercion', () => {
  it('coerces numeric query params from strings to numbers', async () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const handlerSpy = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const cap = makeCapability({
      kind: 'query',
      name: 'listItems',
      input: z.object({
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      output: z.object({
        items: z.array(z.unknown()),
        total: z.number(),
      }),
      handler: handlerSpy,
    });

    registerCapabilityRoute(app as any, cap, config);

    // Simulate Fastify calling the registered GET handler
    const registeredHandler = app.get.mock.calls[0]?.[1];
    const request = makeMockRequest({ search: 'hello', limit: '25', offset: '0' });
    const reply = makeMockReply();

    await registeredHandler(request, reply);

    // Should succeed (200), not fail with 400 validation error
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(handlerSpy).toHaveBeenCalled();
    const passedInput = handlerSpy.mock.calls[0]?.[1];
    expect(passedInput.limit).toBe(25);
    expect(passedInput.offset).toBe(0);
    expect(passedInput.search).toBe('hello');
  });

  it('coerces boolean query params from strings to booleans', async () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const handlerSpy = vi.fn().mockResolvedValue({ ok: true });
    const cap = makeCapability({
      kind: 'query',
      name: 'checkStatus',
      input: z.object({
        active: z.boolean().optional(),
        verbose: z.boolean().optional(),
      }),
      output: z.object({ ok: z.boolean() }),
      handler: handlerSpy,
    });

    registerCapabilityRoute(app as any, cap, config);

    const registeredHandler = app.get.mock.calls[0]?.[1];
    const request = makeMockRequest({ active: 'true', verbose: 'false' });
    const reply = makeMockReply();

    await registeredHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    const passedInput = handlerSpy.mock.calls[0]?.[1];
    expect(passedInput.active).toBe(true);
    expect(passedInput.verbose).toBe(false);
  });

  it('leaves string query params as strings', async () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const handlerSpy = vi.fn().mockResolvedValue({ id: '1', name: 'Test' });
    const cap = makeCapability({
      kind: 'query',
      name: 'getUser',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
      handler: handlerSpy,
    });

    registerCapabilityRoute(app as any, cap, config);

    const registeredHandler = app.get.mock.calls[0]?.[1];
    const request = makeMockRequest({ id: 'abc-123' });
    const reply = makeMockReply();

    await registeredHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    const passedInput = handlerSpy.mock.calls[0]?.[1];
    expect(passedInput.id).toBe('abc-123');
  });

  it('returns 400 for invalid non-numeric string in number field', async () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({
      kind: 'query',
      name: 'listItems',
      input: z.object({
        limit: z.number().int().min(1).max(100),
      }),
      output: z.object({ items: z.array(z.unknown()) }),
      handler: vi.fn(),
    });

    registerCapabilityRoute(app as any, cap, config);

    const registeredHandler = app.get.mock.calls[0]?.[1];
    const request = makeMockRequest({ limit: 'notanumber' });
    const reply = makeMockReply();

    await registeredHandler(request, reply);

    // NaN stays as string "notanumber", Zod rejects it
    expect(reply.status).toHaveBeenCalledWith(400);
  });
});
