import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConfig } from '../../types/config.js';

const postgresFactory = vi.fn((_options: unknown) => ({ end: vi.fn() }));
vi.mock('postgres', () => ({ default: postgresFactory }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: vi.fn(() => ({})) }));

const { connectPostgresDatabase, postgresConnectionOptions, resetSslWarningForTests } =
  await import('../connection.js');

const base: DatabaseConfig = {
  host: 'db.internal',
  port: 5432,
  database: 'app',
  user: 'app',
  password: 'secret',
};

describe('postgresConnectionOptions TLS handling', () => {
  beforeEach(() => {
    resetSslWarningForTests();
    postgresFactory.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes ssl to the driver when sslEnforce is true', async () => {
    await connectPostgresDatabase({ ...base, ssl: true, sslEnforce: true });
    expect(postgresFactory).toHaveBeenCalledWith({
      host: 'db.internal',
      port: 5432,
      database: 'app',
      username: 'app',
      password: 'secret',
      ssl: true,
    });
  });

  it('does not pass ssl without sslEnforce and warns once', () => {
    const warn = vi.fn();
    const first = postgresConnectionOptions({ ...base, ssl: true }, undefined, {
      logger: { warn },
    });
    postgresConnectionOptions({ ...base, ssl: true }, 'postgres', { logger: { warn } });
    expect(first).not.toHaveProperty('ssl');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('NOT using TLS');
    expect(warn.mock.calls[0]?.[0]).toContain('DATABASE_SSL_ENFORCE=true');
  });

  it('falls back to console.warn when no logger is given', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectPostgresDatabase({ ...base, ssl: true });
    expect(postgresFactory.mock.calls[0]?.[0]).not.toHaveProperty('ssl');
    expect(consoleWarn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when ssl is off', () => {
    const warn = vi.fn();
    const options = postgresConnectionOptions({ ...base, ssl: false }, undefined, {
      logger: { warn },
    });
    expect(options).not.toHaveProperty('ssl');
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes ssl: false through when enforcement is on', () => {
    expect(postgresConnectionOptions({ ...base, ssl: false, sslEnforce: true }).ssl).toBe(false);
  });

  it('uses the maintenance database override', () => {
    expect(postgresConnectionOptions(base, 'postgres').database).toBe('postgres');
  });
});
