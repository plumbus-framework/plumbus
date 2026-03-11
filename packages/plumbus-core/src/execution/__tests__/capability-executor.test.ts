import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { AuthContext } from '../../types/security.js';
import { executeCapability } from '../capability-executor.js';
import { createExecutionContext } from '../context-factory.js';

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    roles: ['admin'],
    scopes: ['read', 'write'],
    provider: 'test',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

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

function makeCtx(authOverrides: Partial<AuthContext> = {}) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const ctx = createExecutionContext({
    auth: makeAuth(authOverrides),
    data: {},
    audit,
  });
  return { ctx, audit };
}

describe('executeCapability', () => {
  it('executes successfully with valid input and authorization', async () => {
    const cap = makeCapability();
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, { id: 'u1' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: 'u1', name: 'Test User' });
    }
  });

  it('rejects invalid input', async () => {
    const cap = makeCapability();
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, { id: 123 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('rejects missing input fields', async () => {
    const cap = makeCapability();
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('denies access when caller lacks required roles', async () => {
    const cap = makeCapability({
      access: { roles: ['superadmin'] },
    } as any);
    const { ctx } = makeCtx({ roles: ['viewer'] });

    const result = await executeCapability(cap, ctx, { id: 'u1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('forbidden');
    }
  });

  it('denies access when no policy defined (deny-by-default)', async () => {
    const cap = makeCapability({ access: undefined } as any);
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, { id: 'u1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('forbidden');
    }
  });

  it('catches handler exceptions and returns internal error', async () => {
    const cap = makeCapability({
      handler: async () => {
        throw new Error('Database connection lost');
      },
    } as any);
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, { id: 'u1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('internal');
      expect(result.error.metadata?.['message']).toBe('Database connection lost');
    }
  });

  it('surfaces thrown PlumbusError directly', async () => {
    const cap = makeCapability({
      handler: async (ctx: any) => {
        throw ctx.errors.notFound('User not found');
      },
    } as any);
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, { id: 'u1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('notFound');
      expect(result.error.message).toBe('User not found');
    }
  });

  it('catches invalid handler output', async () => {
    const cap = makeCapability({
      handler: async () => ({ wrong: 'shape' }),
    } as any);
    const { ctx } = makeCtx();

    const result = await executeCapability(cap, ctx, { id: 'u1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('internal');
      expect(result.error.message).toContain('Invalid output');
    }
  });

  it('records audit on success', async () => {
    const cap = makeCapability();
    const { ctx, audit } = makeCtx();

    await executeCapability(cap, ctx, { id: 'u1' });

    expect(audit.record).toHaveBeenCalledWith(
      'capability.getUser',
      expect.objectContaining({
        capability: 'getUser',
        outcome: 'success',
      }),
    );
  });

  it('records audit on denial', async () => {
    const cap = makeCapability({
      access: { roles: ['superadmin'] },
    } as any);
    const { ctx, audit } = makeCtx({ roles: ['viewer'] });

    await executeCapability(cap, ctx, { id: 'u1' });

    expect(audit.record).toHaveBeenCalledWith(
      'capability.getUser',
      expect.objectContaining({
        outcome: 'denied',
      }),
    );
  });

  it('records audit on failure', async () => {
    const cap = makeCapability({
      handler: async () => {
        throw new Error('boom');
      },
    } as any);
    const { ctx, audit } = makeCtx();

    await executeCapability(cap, ctx, { id: 'u1' });

    expect(audit.record).toHaveBeenCalledWith(
      'capability.getUser',
      expect.objectContaining({
        outcome: 'failure',
      }),
    );
  });

  it('skips audit when audit.enabled is false', async () => {
    const cap = makeCapability({
      audit: { enabled: false, event: 'test' },
    } as any);
    const { ctx, audit } = makeCtx();

    await executeCapability(cap, ctx, { id: 'u1' });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('uses custom audit event name', async () => {
    const cap = makeCapability({
      audit: { enabled: true, event: 'custom.user.query' },
    } as any);
    const { ctx, audit } = makeCtx();

    await executeCapability(cap, ctx, { id: 'u1' });

    expect(audit.record).toHaveBeenCalledWith('custom.user.query', expect.anything());
  });

  it('allows public capabilities without auth', async () => {
    const cap = makeCapability({
      access: { public: true },
    } as any);
    const { ctx } = makeCtx({ userId: undefined, roles: [] });

    const result = await executeCapability(cap, ctx, { id: 'u1' });
    expect(result.success).toBe(true);
  });
});
