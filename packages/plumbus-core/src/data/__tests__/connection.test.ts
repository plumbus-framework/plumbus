import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('postgres', () => ({
  default: vi.fn(() =>
    Object.assign(
      vi.fn(async () => []),
      { end: vi.fn(async () => {}) },
    ),
  ),
}));
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn((sql: unknown) => ({ $client: sql })),
}));

import postgres from 'postgres';
import type { DatabaseConfig } from '../../types/config.js';
import { connectPostgresDatabase, postgresConnectionOptions } from '../connection.js';

const base: DatabaseConfig = {
  host: 'db.internal',
  port: 5432,
  database: 'app',
  user: 'app_user',
  password: 'secret',
};

describe('postgresConnectionOptions', () => {
  it('carries ssl exactly as configured, so a production config connects over TLS', () => {
    expect(postgresConnectionOptions({ ...base, ssl: true }).ssl).toBe(true);
    expect(postgresConnectionOptions({ ...base, ssl: false }).ssl).toBe(false);
    expect(postgresConnectionOptions(base)).not.toHaveProperty('ssl');
  });

  it('maps the config fields and lets maintenance work name another database', () => {
    expect(postgresConnectionOptions({ ...base, ssl: true }, 'postgres')).toEqual({
      host: 'db.internal',
      port: 5432,
      database: 'postgres',
      username: 'app_user',
      password: 'secret',
      ssl: true,
    });
    expect(postgresConnectionOptions(base).database).toBe('app');
  });
});

describe('connectPostgresDatabase', () => {
  beforeEach(() => {
    vi.mocked(postgres).mockClear();
  });

  it('opens the server and worker connection with the configured ssl', async () => {
    await connectPostgresDatabase({ ...base, ssl: true });
    expect(vi.mocked(postgres)).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'db.internal', database: 'app', ssl: true }),
    );
  });

  it('leaves ssl to the driver default when the config does not set it', async () => {
    await connectPostgresDatabase(base);
    const options = vi.mocked(postgres).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('ssl');
  });
});

describe('connectPostgresDatabase pool size', () => {
  beforeEach(() => {
    vi.mocked(postgres).mockClear();
  });

  it('sets the pool max from database.poolSize (DATABASE_POOL_SIZE)', async () => {
    await connectPostgresDatabase({ ...base, poolSize: 3 });
    expect(vi.mocked(postgres)).toHaveBeenCalledWith(expect.objectContaining({ max: 3 }));
  });

  it('leaves max to the driver when poolSize is unset', async () => {
    await connectPostgresDatabase(base);
    const options = vi.mocked(postgres).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('max');
  });

  it('keeps max out of the shared options that maintenance connections use', () => {
    expect(postgresConnectionOptions({ ...base, poolSize: 3 })).not.toHaveProperty('max');
  });
});

describe('connectPostgresDatabase session timeouts', () => {
  beforeEach(() => {
    vi.mocked(postgres).mockClear();
  });

  it('passes statement and idle-in-transaction timeouts as connection parameters', async () => {
    await connectPostgresDatabase({
      ...base,
      statementTimeoutMs: 30000,
      idleInTransactionTimeoutMs: 60000,
    });
    expect(vi.mocked(postgres)).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000 },
      }),
    );
  });

  it('passes only the timeout that is configured', async () => {
    await connectPostgresDatabase({ ...base, statementTimeoutMs: 1000 });
    const options = vi.mocked(postgres).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.connection).toEqual({ statement_timeout: 1000 });
  });

  it('sends no connection parameters when no timeout is configured', async () => {
    await connectPostgresDatabase(base);
    const options = vi.mocked(postgres).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('connection');
  });

  it('keeps maintenance connection options free of the timeouts', () => {
    const options = postgresConnectionOptions(
      { ...base, statementTimeoutMs: 1000, idleInTransactionTimeoutMs: 1000 },
      'postgres',
    );
    expect(options).not.toHaveProperty('connection');
    expect(options).not.toHaveProperty('statement_timeout');
  });
});
