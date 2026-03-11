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
