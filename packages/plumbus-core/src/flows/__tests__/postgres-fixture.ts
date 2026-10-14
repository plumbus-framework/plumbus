import { auditRecords } from '../../audit/schema.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as flows from '../schema.js';
import { jobExecutionsTable } from '../../jobs/schema.js';
import { deadLetterTable, idempotencyTable, outboxTable } from '../../events/outbox.js';

/** Disposable real PostgreSQL, private unix socket, actual framework schema. */
export async function startPostgres() {
  const root = mkdtempSync(join(tmpdir(), 'plumbus-pg-'));
  const bin = process.env.PLUMBUS_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
  const data = join(root, 'data');
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'plumbus', '-A', 'trust', '--no-locale'], {
    stdio: 'ignore',
  });
  execFileSync(
    join(bin, 'pg_ctl'),
    ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-F -h '' -k ${root}`, '-w', 'start'],
    { stdio: 'ignore' },
  );
  const connections: ReturnType<typeof postgres>[] = [];
  function connect() {
    const client = postgres({
      host: root,
      username: 'plumbus',
      database: 'postgres',
      max: 2,
      onnotice: () => {},
    });
    connections.push(client);
    return { sql: client, db: drizzle(client) };
  }
  const connection = connect();
  const schema = {
    auditRecords,
    ...flows,
    jobExecutionsTable,
    deadLetterTable,
    idempotencyTable,
    outboxTable,
  };
  async function close() {
    await Promise.all(connections.map((client) => client.end({ timeout: 1 })));
    execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      stdio: 'ignore',
    });
    rmSync(root, { recursive: true, force: true });
  }
  try {
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    for (const statement of statements) await connection.sql.unsafe(statement);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    ...connection,
    connect,
    async reset() {
      await connection.sql.unsafe(
        'TRUNCATE audit_records, flow_executions, flow_schedules, flow_schedule_ticks, flow_dead_letter, job_executions, event_dead_letter, event_outbox, event_idempotency',
      );
    },
    close,
  };
}
