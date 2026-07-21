import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

const EXPECTED_COLUMNS: Record<string, string[]> = {
  auth_sessions: [
    'id',
    'application_id',
    'session_ref',
    'session_id_hash',
    'user_lookup',
    'principal_envelope',
    'csrf_hash',
    'schema_version',
    'created_at',
    'expires_at',
  ],
  auth_login_transactions: [
    'id',
    'application_id',
    'state_hash',
    'browser_binding_hash',
    'provider_id',
    'payload_envelope',
    'schema_version',
    'created_at',
    'expires_at',
  ],
};

export async function checkAuthSchemaCompatibility(db: PostgresJsDatabase): Promise<void> {
  for (const [tableName, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const rows = (await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tableName}`,
    )) as unknown as Array<{ column_name: string }>;

    if (!rows || rows.length === 0) {
      throw new Error(`auth schema incompatible: missing table ${tableName}`);
    }

    const present = new Set(rows.map((row) => row.column_name));
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`auth schema incompatible: ${tableName}.${column} missing`);
      }
    }
  }
}
