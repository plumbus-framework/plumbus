import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import { CapabilityKind } from '../../types/enums.js';
import type { E2EServerContext } from '../e2e.js';
import { createE2EServer, createTestBearerHeader } from '../e2e.js';

// ── Test Capability ──

function helloCapability(): CapabilityContract {
  return {
    name: 'hello',
    kind: CapabilityKind.Action,
    domain: 'test',
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
    access: { public: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (_ctx, input) => ({ greeting: `Hello, ${input.name}!` }),
  };
}

// ── Tests ──

describe('createE2EServer', () => {
  let server: E2EServerContext | undefined;

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  it('starts a server and provides a baseUrl', async () => {
    server = await createE2EServer({ capabilities: [helloCapability()] });
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves health check endpoint', async () => {
    if (!server) {
      server = await createE2EServer({ capabilities: [helloCapability()] });
    }
    const res = await server.fetch('/health');
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.capabilities).toBe(1);
  });

  it('serves capability routes', async () => {
    if (!server) {
      server = await createE2EServer({ capabilities: [helloCapability()] });
    }
    const res = await server.fetch('/api/test/hello', {
      method: 'POST',
      body: JSON.stringify({ name: 'World' }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Expected 200 but got ${res.status}: ${errBody}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('data');
    expect((body.data as Record<string, unknown>).greeting).toBe('Hello, World!');
  });

  it('returns validation error for invalid input', async () => {
    if (!server) {
      server = await createE2EServer({ capabilities: [helloCapability()] });
    }
    const res = await server.fetch('/api/test/hello', {
      method: 'POST',
      body: JSON.stringify({ name: 123 }),
    });
    expect(res.ok).toBe(false);
  });

  it('shuts down cleanly', async () => {
    const s = await createE2EServer({ capabilities: [] });
    await s.close();
    // Server should be closed; fetch should fail
    await expect(s.fetch('/health')).rejects.toThrow();
  });
});

describe('createE2EServer with options', () => {
  it('starts with no capabilities', async () => {
    const server = await createE2EServer();
    try {
      const res = await server.fetch('/health');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.capabilities).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('accepts custom config', async () => {
    const server = await createE2EServer({
      config: { appName: 'custom-app' } as any,
    });
    try {
      expect(server.baseUrl).toMatch(/^http/);
    } finally {
      await server.close();
    }
  });
});

describe('createTestBearerHeader', () => {
  it('returns an authorization header with Bearer token', () => {
    const headers = createTestBearerHeader();
    expect(headers.authorization).toMatch(/^Bearer test\./);
  });

  it('encodes auth context into the token payload', () => {
    const headers = createTestBearerHeader({ userId: 'user-1', roles: ['admin'], tenantId: 't-1' });
    const token = headers.authorization.replace('Bearer test.', '').replace('.sig', '');
    const payload = JSON.parse(atob(token));
    expect(payload.sub).toBe('user-1');
    expect(payload.roles).toEqual(['admin']);
    expect(payload.tenantId).toBe('t-1');
  });

  it('uses defaults when no auth provided', () => {
    const headers = createTestBearerHeader();
    const token = headers.authorization.replace('Bearer test.', '').replace('.sig', '');
    const payload = JSON.parse(atob(token));
    expect(payload.sub).toBe('e2e-user');
    expect(payload.roles).toEqual(['user']);
    expect(payload.tenantId).toBe('e2e-tenant');
  });
});
