import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { DataInternalError } from '../errors/index.js';

/** Deadline calculations and claim predicates use the same database clock. */
export async function databaseTime(db: Pick<PostgresJsDatabase, 'execute'>): Promise<Date> {
  const rows = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const parsed = z.coerce.date().safeParse(rows[0]?.now);
  if (!parsed.success) throw new DataInternalError('Database clock unavailable');
  return parsed.data;
}
