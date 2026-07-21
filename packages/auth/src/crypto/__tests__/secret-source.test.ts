import { afterEach, describe, expect, it } from 'vitest';
import { resolveSecretSource, secretSourceSchema } from '../secret-source.js';

describe('secretSourceSchema', () => {
  it('accepts string, env, literal, and async function sources', () => {
    expect(secretSourceSchema.parse('plain-secret')).toBe('plain-secret');
    expect(secretSourceSchema.parse({ env: 'OKTA_CLIENT_SECRET' })).toEqual({
      env: 'OKTA_CLIENT_SECRET',
    });
    expect(secretSourceSchema.parse({ literal: 'dev-only' })).toEqual({ literal: 'dev-only' });
    expect(secretSourceSchema.parse(async () => 'from-fn')).toBeTypeOf('function');
  });

  it('rejects unknown object shapes', () => {
    expect(() => secretSourceSchema.parse({ env: 'X', extra: true })).toThrow();
    expect(() => secretSourceSchema.parse({ foo: 'bar' })).toThrow();
  });
});

describe('resolveSecretSource', () => {
  afterEach(() => {
    delete process.env.TEST_AUTH_SECRET;
  });

  it('resolves string and literal sources', async () => {
    await expect(resolveSecretSource('abc')).resolves.toBe('abc');
    await expect(resolveSecretSource({ literal: 'dev-only' })).resolves.toBe('dev-only');
  });

  it('resolves env sources from process.env', async () => {
    process.env.TEST_AUTH_SECRET = 'from-env';
    await expect(resolveSecretSource({ env: 'TEST_AUTH_SECRET' })).resolves.toBe('from-env');
  });

  it('throws when env var is missing or empty', async () => {
    await expect(resolveSecretSource({ env: 'MISSING_AUTH_SECRET' })).rejects.toThrow(
      /MISSING_AUTH_SECRET/,
    );
    process.env.TEST_AUTH_SECRET = '';
    await expect(resolveSecretSource({ env: 'TEST_AUTH_SECRET' })).rejects.toThrow(
      /TEST_AUTH_SECRET/,
    );
  });

  it('resolves async function sources', async () => {
    await expect(resolveSecretSource(async () => 'async-secret')).resolves.toBe('async-secret');
  });
});
