import { describe, expect, it } from 'vitest';
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
});
