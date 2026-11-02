import { describe, expect, it } from 'vitest';
import {
  exposeOriginalError,
  getErrorExecutionDetails,
  getOriginalError,
  preserveOriginalError,
} from '../error-diagnostics.js';

describe('in-memory error provenance', () => {
  it('does not attribute a reused exception to a different tenant or caller', () => {
    const shared = preserveOriginalError(new Error('shared'), new TypeError('original'), {
      actorUserId: 'user-a',
      tenantId: 'tenant-a',
      correlationId: 'a',
    });
    const current = { actorUserId: 'user-b', tenantId: 'tenant-b', correlationId: 'b' };
    expect(getErrorExecutionDetails(shared, current)).toBe(current);
    expect(getOriginalError(shared)).toBeInstanceOf(TypeError);
  });
  it('preserves nested error identity and snapshots execution coordinates without serialization', () => {
    const original = new TypeError('failure');
    const stack = ['ops.outer', 'ops.inner'];
    const normalized = preserveOriginalError({ code: 'internal', message: 'failed' }, original, {
      capabilityStack: stack,
      correlationId: 'request-1',
    });
    stack.push('mutated');
    preserveOriginalError(normalized, normalized, { capabilityStack: ['ops.outer'] });
    const info = exposeOriginalError(
      { source: 'http' },
      getOriginalError(normalized),
      getErrorExecutionDetails(normalized),
    );
    expect(getOriginalError(normalized)).toBe(original);
    expect(getErrorExecutionDetails(normalized)?.capabilityStack).toEqual([
      'ops.outer',
      'ops.inner',
    ]);
    expect(JSON.stringify(normalized)).toBe('{"code":"internal","message":"failed"}');
    expect(JSON.stringify(info)).toBe('{"source":"http"}');
    expect(Object.getOwnPropertyDescriptor(info, 'originalError')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(info, 'diagnostics')?.enumerable).toBe(false);
  });

  it('does not let immutable/proxy error services change execution outcomes', () => {
    const frozen = Object.freeze({ code: 'internal' });
    expect(preserveOriginalError(frozen, new Error('failure'))).toBe(frozen);
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('unreadable');
        },
      },
    );
    expect(getOriginalError(proxy)).toBeUndefined();
    expect(getErrorExecutionDetails(proxy)).toBeUndefined();
    expect(() => exposeOriginalError(frozen, new Error('failure'))).not.toThrow();
  });
});
