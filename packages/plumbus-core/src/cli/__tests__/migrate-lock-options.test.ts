import { describe, expect, it } from 'vitest';
import { resolveMigrateLockOptions } from '../commands/migrate.js';

describe('migrate apply lock options', () => {
  it('leaves the runner defaults when neither a flag nor the environment sets them', () => {
    expect(resolveMigrateLockOptions({}, {})).toEqual({});
  });

  it('reads the environment, and a flag wins over it', () => {
    const env = {
      PLUMBUS_MIGRATION_LOCK_TIMEOUT_MS: '2000',
      PLUMBUS_MIGRATION_LOCK_RETRIES: '5',
    };
    expect(resolveMigrateLockOptions({}, env)).toEqual({ lockTimeoutMs: 2000, lockRetries: 5 });
    expect(resolveMigrateLockOptions({ lockTimeout: '0', lockRetries: '1' }, env)).toEqual({
      lockTimeoutMs: 0,
      lockRetries: 1,
    });
  });

  it('refuses a value that is not a whole number', () => {
    expect(() => resolveMigrateLockOptions({ lockTimeout: '5s' }, {})).toThrow('--lock-timeout');
    expect(() => resolveMigrateLockOptions({}, { PLUMBUS_MIGRATION_LOCK_RETRIES: '-1' })).toThrow(
      'PLUMBUS_MIGRATION_LOCK_RETRIES',
    );
  });
});
