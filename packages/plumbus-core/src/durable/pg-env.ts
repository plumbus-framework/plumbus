// Postgres admin coordinates for durable harness tests.
// Every port comes from the environment — never a literal in source.

export interface TestPostgresAdmin {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function resolveTestPostgresAdmin(
  env: Record<string, string | undefined> = process.env,
): TestPostgresAdmin {
  const portRaw = env.PLUMBUS_TEST_PG_PORT ?? env.PGPORT ?? env.DB_PORT;
  if (!portRaw?.trim()) {
    throw new Error(
      'Durable test harness needs a Postgres port from PLUMBUS_TEST_PG_PORT, PGPORT, or DB_PORT',
    );
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Postgres port from environment: ${portRaw}`);
  }
  return {
    host: env.PLUMBUS_TEST_PG_HOST ?? env.PGHOST ?? env.DB_HOST ?? 'localhost',
    port,
    database: env.PLUMBUS_TEST_PG_DATABASE ?? env.PGDATABASE ?? 'postgres',
    user: env.PLUMBUS_TEST_PG_USER ?? env.PGUSER ?? env.DB_USER ?? 'postgres',
    password: env.PLUMBUS_TEST_PG_PASSWORD ?? env.PGPASSWORD ?? env.DB_PASSWORD ?? 'postgres',
  };
}
