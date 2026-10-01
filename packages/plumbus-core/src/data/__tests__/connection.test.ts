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
