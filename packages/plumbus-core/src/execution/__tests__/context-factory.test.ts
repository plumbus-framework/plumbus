import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/context.js';
import type { AuthContext } from '../../types/security.js';
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

describe('createExecutionContext', () => {
  it('assembles a full context from dependencies', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
    });

    expect(ctx.auth.userId).toBe('user-1');
    expect(ctx.data).toEqual({});
    expect(ctx.events).toBeDefined();
    expect(ctx.flows).toBeDefined();
    expect(ctx.ai).toBeDefined();
    expect(ctx.audit).toBeDefined();
    expect(ctx.errors).toBeDefined();
    expect(ctx.logger).toBeDefined();
    expect(ctx.time).toBeDefined();
    expect(ctx.config).toBeDefined();
  });

  it('uses provided services when given', async () => {
    const customEvents = {
      emit: async () => {},
      emitMany: async () => {},
    };
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      events: customEvents,
    });

    expect(ctx.events).toBe(customEvents);
  });

  it('provides working error service', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
    });

    const err = ctx.errors.validation('bad input');
    expect(err.code).toBe('validation');
    expect(err.message).toBe('bad input');
  });

  it('provides working time service', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
    });

    const now = ctx.time.now();
    expect(now).toBeInstanceOf(Date);
  });

  it('stubs AI service to throw when not configured', async () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
    });

    await expect(ctx.ai.generate({ prompt: 'test', input: {} })).rejects.toThrow(
      'AI service not configured',
    );
  });

  it('passes through custom config', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      config: { appName: 'test-app' },
    });

    expect(ctx.config.appName).toBe('test-app');
  });

  it('provides security service with hasRole/hasScope', () => {
    const ctx = createExecutionContext({
      auth: makeAuth({ roles: ['admin', 'editor'], scopes: ['read', 'write'] }),
      data: {},
    });

    expect(ctx.security.hasRole('admin')).toBe(true);
    expect(ctx.security.hasRole('viewer')).toBe(false);
    expect(ctx.security.hasScope('read')).toBe(true);
    expect(ctx.security.hasScope('delete')).toBe(false);
  });

  it('security.hasAllRoles checks multiple roles', () => {
    const ctx = createExecutionContext({
      auth: makeAuth({ roles: ['admin', 'editor'] }),
      data: {},
    });

    expect(ctx.security.hasAllRoles(['admin', 'editor'])).toBe(true);
    expect(ctx.security.hasAllRoles(['admin', 'superadmin'])).toBe(false);
  });

  it('security.hasAllScopes checks multiple scopes', () => {
    const ctx = createExecutionContext({
      auth: makeAuth({ scopes: ['read', 'write'] }),
      data: {},
    });

    expect(ctx.security.hasAllScopes(['read', 'write'])).toBe(true);
    expect(ctx.security.hasAllScopes(['read', 'delete'])).toBe(false);
  });

  it('security.requireRole throws for missing role', () => {
    const ctx = createExecutionContext({
      auth: makeAuth({ roles: ['editor'] }),
      data: {},
    });

    expect(() => ctx.security.requireRole('editor')).not.toThrow();
    expect(() => ctx.security.requireRole('admin')).toThrow('Forbidden');
  });

  it('security.requireScope throws for missing scope', () => {
    const ctx = createExecutionContext({
      auth: makeAuth({ scopes: ['read'] }),
      data: {},
    });

    expect(() => ctx.security.requireScope('read')).not.toThrow();
    expect(() => ctx.security.requireScope('write')).toThrow('Forbidden');
  });

  it('passes through request metadata when provided', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      request: { sourceIp: '192.168.1.1', userAgent: 'TestBrowser/1.0' },
    });

    expect(ctx.request?.sourceIp).toBe('192.168.1.1');
    expect(ctx.request?.userAgent).toBe('TestBrowser/1.0');
  });

  it('request is undefined when not provided', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
    });

    expect(ctx.request).toBeUndefined();
  });
});

describe('createExecutionContext — sealed identity/authority surface', () => {
  it('freezes the context container and the auth object', () => {
    const ctx = createExecutionContext({ auth: makeAuth(), data: {} });

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.auth)).toBe(true);
  });

  it('freezes the role and scope arrays on auth', () => {
    const ctx = createExecutionContext({
      auth: makeAuth({ roles: ['editor'], scopes: ['read'] }),
      data: {},
    });

    expect(Object.isFrozen(ctx.auth.roles)).toBe(true);
    expect(Object.isFrozen(ctx.auth.scopes)).toBe(true);
    expect(() => ctx.auth.roles.push('admin')).toThrow(TypeError);
    expect(ctx.auth.roles).toEqual(['editor']);
  });

  it('freezes nested claim records carried on auth', () => {
    const nested = {
      ...makeAuth(),
      delegation: { onBehalfOf: 'user-9', chain: ['user-1', 'user-9'] },
    };
    const ctx = createExecutionContext({ auth: nested as AuthContext, data: {} });
    const delegation = (ctx.auth as typeof nested).delegation;

    expect(Object.isFrozen(delegation)).toBe(true);
    expect(Object.isFrozen(delegation.chain)).toBe(true);
  });

  it('assignment to ctx.auth.userId does not change it', () => {
    const ctx = createExecutionContext({ auth: makeAuth({ userId: 'user-1' }), data: {} });

    // ESM modules are always strict, so a write to a frozen property throws.
    expect(() => {
      ctx.auth.userId = 'attacker';
    }).toThrow(TypeError);
    expect(ctx.auth.userId).toBe('user-1');

    // The non-throwing path (sloppy-mode assignment) fails silently instead.
    expect(Reflect.set(ctx.auth, 'userId', 'attacker')).toBe(false);
    expect(ctx.auth.userId).toBe('user-1');
  });

  it('the whole auth object cannot be re-pointed at a fabricated actor', () => {
    const ctx = createExecutionContext({ auth: makeAuth({ roles: ['viewer'] }), data: {} });

    expect(() => {
      (ctx as { auth: AuthContext }).auth = makeAuth({ roles: ['admin'] });
    }).toThrow(TypeError);
    expect(ctx.auth.roles).toEqual(['viewer']);
    expect(ctx.security.hasRole('admin')).toBe(false);
  });

  it('elevating tenantId on the auth object is rejected', () => {
    const ctx = createExecutionContext({ auth: makeAuth({ tenantId: 'tenant-1' }), data: {} });

    expect(Reflect.set(ctx.auth, 'tenantId', 'tenant-2')).toBe(false);
    expect(ctx.auth.tenantId).toBe('tenant-1');
  });

  it('freezes the deps.auth object in place so service closures see the same actor', () => {
    const auth = makeAuth();
    const ctx = createExecutionContext({ auth, data: {} });

    expect(ctx.auth).toBe(auth);
    expect(Object.isFrozen(auth)).toBe(true);
  });

  it('freezes request provenance when provided', () => {
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      request: { sourceIp: '10.0.0.1', userAgent: 'Agent/1.0' },
    });

    expect(Object.isFrozen(ctx.request)).toBe(true);
    expect(Reflect.set(ctx.request as object, 'sourceIp', '10.0.0.2')).toBe(false);
    expect(ctx.request?.sourceIp).toBe('10.0.0.1');
  });

  it('seals the security service so authority predicates cannot be replaced', () => {
    const ctx = createExecutionContext({ auth: makeAuth({ roles: ['viewer'] }), data: {} });

    expect(Object.isFrozen(ctx.security)).toBe(true);
    expect(Reflect.set(ctx.security, 'hasRole', () => true)).toBe(false);
    expect(ctx.security.hasRole('admin')).toBe(false);
  });

  it('a service cannot be swapped out from under the container', () => {
    const ctx = createExecutionContext({ auth: makeAuth(), data: {} });

    expect(Reflect.set(ctx, 'data', { escaped: true })).toBe(false);
    expect(Reflect.set(ctx, 'audit', { record: async () => {} })).toBe(false);
    expect(ctx.data).toEqual({});
  });

  it('leaves service objects mutable so audit buffers and emit scopes keep working', async () => {
    const recorded: string[] = [];
    const audit = {
      async record(eventType: string) {
        recorded.push(eventType);
      },
    };
    const emitScope: { executingCapability?: string } = {};
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      audit,
      invocationEmitScope: emitScope,
    });

    expect(Object.isFrozen(ctx.audit)).toBe(false);
    expect(Object.isFrozen(ctx.__runtime)).toBe(false);
    expect(Object.isFrozen(ctx.__runtime?.invocationEmitScope)).toBe(false);

    // The executor sets and restores causation on the emit scope per invocation.
    if (ctx.__runtime?.invocationEmitScope) {
      ctx.__runtime.invocationEmitScope.executingCapability = 'billing.charge';
    }
    expect(emitScope.executingCapability).toBe('billing.charge');

    await ctx.audit.record('capability.executed');
    expect(recorded).toEqual(['capability.executed']);
  });

  it('derived contexts stay writable but carry the same frozen actor', () => {
    const ctx = createExecutionContext({ auth: makeAuth({ roles: ['viewer'] }), data: {} });

    // How the flow engine and capability executor build step/handler contexts.
    const derived: ExecutionContext = { ...ctx, step: 'validate', state: { seen: true } };

    expect(Object.isFrozen(derived)).toBe(false);
    expect(derived.step).toBe('validate');
    expect(derived.auth).toBe(ctx.auth);
    expect(Object.isFrozen(derived.auth)).toBe(true);
    expect(Reflect.set(derived.auth, 'roles', ['admin'])).toBe(false);
    expect(derived.auth.roles).toEqual(['viewer']);
  });

  it('seals nested arrays even when the caller shallow-froze the auth object', () => {
    const auth = Object.freeze(makeAuth({ roles: ['viewer'] }));
    const ctx = createExecutionContext({ auth, data: {} });

    expect(Object.isFrozen(ctx.auth.roles)).toBe(true);
    expect(() => ctx.auth.roles.push('admin')).toThrow(TypeError);
  });

  it('does not invoke computed claim getters while sealing', () => {
    let reads = 0;
    const auth = makeAuth();
    Object.defineProperty(auth, 'derivedClaim', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 'computed';
      },
    });

    const ctx = createExecutionContext({ auth, data: {} });

    expect(reads).toBe(0);
    expect((ctx.auth as AuthContext & { derivedClaim: string }).derivedClaim).toBe('computed');
    expect(reads).toBe(1);
  });

  it('is idempotent when the same auth object builds several contexts', () => {
    const auth = makeAuth();
    const first = createExecutionContext({ auth, data: {} });
    const second = createExecutionContext({ auth, data: {} });

    expect(first.auth).toBe(second.auth);
    expect(Object.isFrozen(second.auth)).toBe(true);
  });
});

describe('createExecutionContext — per-invocation attachments', () => {
  it('carries a cancellation signal supplied at construction', () => {
    const controller = new AbortController();
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      signal: controller.signal,
    });

    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.signal?.aborted).toBe(false);

    controller.abort();
    expect(ctx.signal?.aborted).toBe(true);
  });

  it('carries a progress reporter supplied at construction', () => {
    const reported: Array<{ progress: number; total?: number; message?: string }> = [];
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      progress: { report: (opts) => reported.push(opts) },
    });

    ctx.progress?.report({ progress: 1, total: 3, message: 'working' });
    expect(reported).toEqual([{ progress: 1, total: 3, message: 'working' }]);
  });

  it('leaves signal and progress undefined when the host supplies neither', () => {
    const ctx = createExecutionContext({ auth: makeAuth(), data: {} });

    expect(ctx.signal).toBeUndefined();
    expect(ctx.progress).toBeUndefined();
  });

  it('rejects attaching a signal to a finished context, so hosts pass it in deps', () => {
    const ctx = createExecutionContext({ auth: makeAuth(), data: {} });
    const controller = new AbortController();

    expect(() => {
      (ctx as { signal?: AbortSignal }).signal = controller.signal;
    }).toThrow(TypeError);
    expect(ctx.signal).toBeUndefined();
  });

  it('lets a host that learns of a signal later derive a context by spreading', () => {
    const base = createExecutionContext({ auth: makeAuth({ roles: ['viewer'] }), data: {} });
    const controller = new AbortController();

    const derived: ExecutionContext = { ...base, signal: controller.signal };

    expect(derived.signal).toBe(controller.signal);
    expect(base.signal).toBeUndefined();
    expect(derived.auth).toBe(base.auth);
    expect(Object.isFrozen(derived.auth)).toBe(true);
  });
});
