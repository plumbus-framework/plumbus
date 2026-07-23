import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresLoginTransactionStore,
  createPostgresSessionStore,
  checkAuthSchemaCompatibility,
} from '../postgres/index.js';
import { describeLoginTransactionStoreContract, describeSessionStoreContract } from './contract.js';

const pgEnabled = process.env.PLUMBUS_PG_TEST === '1';
const databaseUrl = process.env.PLUMBUS_TEST_DATABASE_URL;

describe.runIf(pgEnabled && Boolean(databaseUrl))('postgres auth stores', () => {
  const sql = postgres(databaseUrl ?? '', { max: 1 });
  const db = drizzle(sql);
  let sessionStore: ReturnType<typeof createPostgresSessionStore>;
  let transactionStore: ReturnType<typeof createPostgresLoginTransactionStore>;

  beforeAll(async () => {
    const migrationPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../migrations/0001_auth_init.sql',
    );
    const ddl = readFileSync(migrationPath, 'utf8');
    await sql.unsafe(ddl);
    await sql`TRUNCATE auth_sessions, auth_login_transactions`;
    sessionStore = createPostgresSessionStore(db);
    transactionStore = createPostgresLoginTransactionStore(db);
  });

  afterAll(async () => {
    await sql`TRUNCATE auth_sessions, auth_login_transactions`;
    await sql.end({ timeout: 5 });
  });

  describeSessionStoreContract('postgres', () => sessionStore);
  describeLoginTransactionStoreContract('postgres', () => transactionStore);

  it('checkAuthSchemaCompatibility passes on migrated schema', async () => {
    await expect(checkAuthSchemaCompatibility(db)).resolves.toBeUndefined();
  });

  it('checkAuthSchemaCompatibility fails when a column is dropped', async () => {
    await sql`ALTER TABLE auth_sessions DROP COLUMN IF EXISTS csrf_hash`;
    await expect(checkAuthSchemaCompatibility(db)).rejects.toThrow(/csrf_hash/);
    await sql`ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS csrf_hash text NOT NULL DEFAULT ''`;
  });

  it('consume is single-winner under parallel contention', async () => {
    await transactionStore.create({
      applicationId: 'app-1',
      stateHash: 'race-state',
      browserBindingHash: 'race-bind',
      providerId: 'cognito',
      payloadEnvelope: 'env',
      schemaVersion: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T01:00:00.000Z'),
    });
    const query = {
      applicationId: 'app-1',
      stateHash: 'race-state',
      browserBindingHash: 'race-bind',
      providerId: 'cognito',
      now: new Date('2026-01-01T00:30:00.000Z'),
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transactionStore.consume(query)),
    );
    const winners = results.filter((row) => row !== null);
    expect(winners).toHaveLength(1);
  });
});
