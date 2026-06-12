import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ErrorCode } from '../../types/enums.js';
import type { CapabilityContract } from '../../types/capability.js';
import { isPlumbusError } from '../../errors/index.js';
import { getCanonicalCapabilityName } from '../canonical-name.js';
import { CapabilityRegistry } from '../capability-registry.js';
import { executeCapability } from '../capability-executor.js';
import { createTestContext } from '../../testing/context.js';

function makeCap(
  name: string,
  domain: string,
  overrides: Partial<CapabilityContract> = {},
): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain,
    input: z.object({ value: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler: async () => ({ ok: true }),
    ...overrides,
  } as CapabilityContract;
}

describe('ctx.capabilities.invoke', () => {
  it('succeeds for declared dependency', async () => {
    const b = makeCap('chargeCard', 'billing', {
      handler: async () => ({ ok: true }),
    });
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(b)],
      },
      handler: async (ctx) => {
        const result = (await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {})) as {
          ok: boolean;
        };
        return { ok: result.ok };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(true);
  });

  it('rejects undeclared invocation', async () => {
    const b = makeCap('chargeCard', 'billing');
    const a = makeCap('createOrder', 'orders', {
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect(result.error.metadata?.reason).toBe('undeclaredInvocation');
  });

  it('rejects runtime circular invocation', async () => {
    const aCanonical = 'orders.createOrder';
    const bCanonical = 'billing.chargeCard';

    const b = makeCap('chargeCard', 'billing', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [aCanonical],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(aCanonical, {});
        return { ok: true };
      },
    });

    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [bCanonical],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(bCanonical, {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect(result.error.metadata?.reason).toBe('circularInvocation');
  });

  it('propagates callee forbidden as forbidden, not dependencyViolation', async () => {
    const b = makeCap('chargeCard', 'billing', {
      access: { roles: ['superadmin'] },
    });
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(b)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.Forbidden);
  });

  it('rejects job capability targets', async () => {
    const job = makeCap('generateReport', 'reports', {
      kind: 'job',
      handler: async () => ({ ok: true }),
    });
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(job)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(job), {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, job],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect(result.error.metadata?.reason).toBe('unsupportedTargetKind');
  });
});

describe('nested capability chains', () => {
  it('A -> B -> C succeeds with audit caller links', async () => {
    const c = makeCap('finalize', 'billing', {
      handler: async () => ({ ok: true }),
    });
    const b = makeCap('chargeCard', 'billing', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(c)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(c), {});
        return { ok: true };
      },
    });
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(b)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {});
        return { ok: true };
      },
    });

    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b, c],
      audit,
    });

    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(true);

    const calleeAudit = audit.record.mock.calls.find(
      (call) => call[1]?.capability === getCanonicalCapabilityName(c),
    );
    expect(calleeAudit?.[1]).toMatchObject({
      caller: getCanonicalCapabilityName(b),
      capabilityStack: expect.arrayContaining([getCanonicalCapabilityName(a)]),
    });
  });

  it('nested undeclared B -> C fails with caller B', async () => {
    const c = makeCap('finalize', 'billing');
    const b = makeCap('chargeCard', 'billing', {
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(c), {});
        return { ok: true };
      },
    });
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(b)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b, c],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect(result.error.metadata?.reason).toBe('undeclaredInvocation');
    expect(result.error.metadata?.caller).toBe(getCanonicalCapabilityName(b));
    expect(result.error.metadata?.target).toBe(getCanonicalCapabilityName(c));
  });
});

describe('CapabilityRegistry canonical names', () => {
  it('indexes by domain.name', () => {
    const reg = new CapabilityRegistry();
    const cap = makeCap('getUser', 'users');
    reg.register(cap);
    expect(reg.get('users.getUser')).toBe(cap);
    expect(reg.get('getUser')).toBeUndefined();
  });
});

describe('defineCapability effects.capabilities validation', () => {
  it('rejects non-canonical dependency names', async () => {
    const { defineCapability } = await import('../../define/defineCapability.js');
    expect(() =>
      defineCapability({
        name: 'a',
        kind: 'action',
        domain: 'test',
        input: z.object({}),
        output: z.object({}),
        effects: { data: [], events: [], external: [], ai: false, capabilities: ['shortName'] },
        handler: async () => ({}),
      }),
    ).toThrow(/canonical format/);
  });
});

describe('invocationUnavailable and missingCapability', () => {
  it('reports invocationUnavailable when no registry invoker is wired', async () => {
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: ['billing.chargeCard'],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke('billing.chargeCard', {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({ auth: { roles: ['admin'] } });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect(result.error.metadata?.reason).toBe('invocationUnavailable');
  });

  it('reports missingCapability for declared but unregistered targets', async () => {
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: ['billing.missingTarget'],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke('billing.missingTarget', {});
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect(result.error.metadata?.reason).toBe('missingCapability');
  });
});

describe('handler __runtime surface', () => {
  it('does not expose invokeCapability on handler-visible __runtime', async () => {
    const a = makeCap('probe', 'orders', {
      handler: async (ctx) => {
        expect(ctx.__runtime?.invokeCapability).toBeUndefined();
        expect(ctx.__runtime?.resolveCapability).toBeUndefined();
        expect(ctx.__runtime?.invocationEmitScope).toBeUndefined();
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(true);
  });
});

describe('nested capability event causation', () => {
  it('sets causationId to immediate caller when callee emits an event', async () => {
    const { createExecutionContext } = await import('../context-factory.js');
    const { createInvocationEmitScope, resolveInvocationCausationId } = await import(
      '../invocation-emit-scope.js'
    );
    const { createEventEmitter } = await import('../../events/emitter.js');
    const { EventRegistry } = await import('../../events/registry.js');
    const { buildCapabilityRuntimeDeps } = await import('../capability-invocation.js');
    const { createTestAuth, createTestData, fixedTime, mockAI, mockAudit, mockFlows, mockLogger } =
      await import('../../testing/context.js');

    const outboxRows: Array<{ causationId?: string | null }> = [];
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((row: { causationId?: string | null }) => {
          outboxRows.push(row);
          return Promise.resolve();
        }),
      }),
    };

    const emitScope = createInvocationEmitScope();
    const events = createEventEmitter({
      db: db as never,
      auth: createTestAuth({ roles: ['admin'] }),
      registry: new EventRegistry(),
      getCausationId: () => resolveInvocationCausationId(emitScope),
    });

    const c = makeCap('finalize', 'billing', {
      handler: async (ctx) => {
        await ctx.events.emit('order.done', { ok: true });
        return { ok: true };
      },
    });
    const b = makeCap('chargeCard', 'billing', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(c)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(c), {});
        return { ok: true };
      },
    });
    const a = makeCap('createOrder', 'orders', {
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [getCanonicalCapabilityName(b)],
      },
      handler: async (ctx) => {
        await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {});
        return { ok: true };
      },
    });

    const registry = new CapabilityRegistry();
    registry.registerAll([a, b, c]);

    const ctx = createExecutionContext({
      auth: createTestAuth({ roles: ['admin'] }),
      data: createTestData(),
      events,
      flows: mockFlows(),
      ai: mockAI(),
      audit: mockAudit(),
      logger: mockLogger(),
      time: fixedTime(),
      config: {},
      invocationEmitScope: emitScope,
      ...buildCapabilityRuntimeDeps(registry),
    });

    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(true);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.causationId).toBe(getCanonicalCapabilityName(b));
  });
});

describe('handler thrown dependency violations', () => {
  it('surfaces dependencyViolation when handler catches and rethrows via executeCapability', async () => {
    const b = makeCap('chargeCard', 'billing');
    const a = makeCap('createOrder', 'orders', {
      handler: async (ctx) => {
        try {
          await ctx.capabilities.invoke(getCanonicalCapabilityName(b), {});
        } catch (err) {
          if (isPlumbusError(err)) throw err;
        }
        return { ok: true };
      },
    });

    const ctx = createTestContext({
      auth: { roles: ['admin'] },
      capabilities: [a, b],
    });
    const result = await executeCapability(a, ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
  });
});
