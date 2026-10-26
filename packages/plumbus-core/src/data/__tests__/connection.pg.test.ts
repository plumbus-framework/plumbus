// DATABASE_POOL_SIZE reaches the main postgres.js pool: a real server sees at most that many
// backends from one pool, however many queries run at once.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/loader.js';
import { createDurableTestDatabase, resolveTestPostgresAdmin } from '../../durable/index.js';
import { closeDatabaseConnection, connectPostgresDatabase } from '../connection.js';

describe('main pool size against Postgres', () => {
  it('opens no more backends than DATABASE_POOL_SIZE', async () => {
    const admin = resolveTestPostgresAdmin();
    const database = await createDurableTestDatabase({ admin, kind: 'pool_size', ddl: '' });
    const config = loadConfig({
      env: {
        DATABASE_HOST: admin.host,
        DATABASE_PORT: String(admin.port),
        DATABASE_NAME: database.name,
        DATABASE_USER: admin.user,
        DATABASE_PASSWORD: admin.password,
        DATABASE_POOL_SIZE: '2',
      },
    });
    const connection = await connectPostgresDatabase(config.database);
    try {
      const sql = connection.sql;
      if (!sql) throw new Error('expected a live postgres.js client');
      const rows = await Promise.all(
        Array.from(
          { length: 6 },
          () => sql<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid, pg_sleep(0.1)
        `,
        ),
      );
      const pids = new Set(rows.map((result) => result[0]?.pid));
      expect(pids.size).toBe(2);
    } finally {
      await closeDatabaseConnection(connection);
      await database.close();
    }
  }, 30_000);

  it('applies the configured session timeouts to the main pool', async () => {
    const admin = resolveTestPostgresAdmin();
    const database = await createDurableTestDatabase({ admin, kind: 'pool_timeouts', ddl: '' });
    const config = loadConfig({
      env: {
        DATABASE_HOST: admin.host,
        DATABASE_PORT: String(admin.port),
        DATABASE_NAME: database.name,
        DATABASE_USER: admin.user,
        DATABASE_PASSWORD: admin.password,
        DATABASE_STATEMENT_TIMEOUT_MS: '250',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '3000',
      },
    });
    const connection = await connectPostgresDatabase(config.database);
    try {
      const sql = connection.sql;
      if (!sql) throw new Error('expected a live postgres.js client');
      const [settings] = await sql<Array<{ statement: string; idle: string }>>`
        SELECT current_setting('statement_timeout') AS statement,
               current_setting('idle_in_transaction_session_timeout') AS idle
      `;
      expect(settings).toEqual({ statement: '250ms', idle: '3s' });
      // 57014 query_canceled: the server cut the statement at the configured timeout.
      await expect(sql`SELECT pg_sleep(2)`).rejects.toMatchObject({ code: '57014' });
    } finally {
      await closeDatabaseConnection(connection);
      await database.close();
    }
  }, 30_000);
});
