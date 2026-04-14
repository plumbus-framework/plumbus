import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import { registerAllRoutes, registerCapabilityRoute } from '../route-generator.js';

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

function makeMockRequest(query: Record<string, string> = {}) {
  return {
    headers: { authorization: 'Bearer test-token' },
    query,
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

  it('skips eventHandler capabilities', () => {
    const app = makeMockApp();
    const config = makeMockConfig();
    const cap = makeCapability({ kind: 'eventHandler', name: 'onUserCreated' });

    registerCapabilityRoute(app as any, cap, config);

    expect(app.get).not.toHaveBeenCalled();
    expect(app.post).not.toHaveBeenCalled();
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
