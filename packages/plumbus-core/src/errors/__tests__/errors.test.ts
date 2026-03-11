import { describe, expect, it } from 'vitest';
import { createErrorService, isPlumbusError } from '../index.js';

describe('ErrorService', () => {
  const errors = createErrorService();

  it('creates a validation error', () => {
    const err = errors.validation('invalid email');
    expect(err.code).toBe('validation');
    expect(err.message).toBe('invalid email');
  });

  it('creates a notFound error', () => {
    const err = errors.notFound('user not found');
    expect(err.code).toBe('notFound');
  });

  it('creates a forbidden error', () => {
    const err = errors.forbidden('access denied');
    expect(err.code).toBe('forbidden');
  });

  it('creates a conflict error', () => {
    const err = errors.conflict('duplicate email');
    expect(err.code).toBe('conflict');
  });

  it('creates an internal error', () => {
    const err = errors.internal('unexpected failure');
    expect(err.code).toBe('internal');
  });

  it('attaches metadata', () => {
    const err = errors.validation('bad', { field: 'email' });
    expect(err.metadata).toEqual({ field: 'email' });
  });
});

describe('isPlumbusError', () => {
  const errors = createErrorService();

  it('returns true for PlumbusError', () => {
    expect(isPlumbusError(errors.validation('x'))).toBe(true);
  });

  it('returns false for random objects', () => {
    expect(isPlumbusError({ code: 'unknown', message: 'x' })).toBe(false);
    expect(isPlumbusError(null)).toBe(false);
    expect(isPlumbusError('string')).toBe(false);
  });
});
