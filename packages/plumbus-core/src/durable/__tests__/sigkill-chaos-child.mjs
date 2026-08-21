import postgres from 'postgres';

const PLAN02_DB = /^plumbus_plan02_[a-z0-9_]+$/;
const tenant = process.env.PLAN02_TENANT_DB ?? '';
if (!PLAN02_DB.test(tenant)) {
  console.error('sigkill-chaos-child refuses a non-plan02 database');
  process.exit(2);
}

const portRaw = process.env.PLUMBUS_TEST_PG_PORT ?? process.env.PGPORT ?? process.env.DB_PORT;
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('sigkill-chaos-child needs a Postgres port from the environment');
  process.exit(2);
}

const schema = process.env.PLAN02_CORE_SCHEMA ?? 'core_plumbus';
if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
  console.error('sigkill-chaos-child refuses an unsafe schema name');
  process.exit(2);
}

const sql = postgres({
  host: process.env.PLUMBUS_TEST_PG_HOST ?? process.env.PGHOST ?? process.env.DB_HOST ?? 'localhost',
  port,
  database: tenant,
  username: process.env.PLUMBUS_TEST_PG_USER ?? process.env.PGUSER ?? process.env.DB_USER ?? 'postgres',
  password: process.env.PLUMBUS_TEST_PG_PASSWORD ?? process.env.PGPASSWORD ?? process.env.DB_PASSWORD ?? 'postgres',
  max: 1,
  connect_timeout: 10,
  onnotice: () => {},
});

const now = new Date().toISOString();

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO "${schema}".execution_state (
        execution_id, state_ref_id, tenant_ref, revision, tenant_epoch, status,
        definition_id, definition_version, current_step_id, step_index, attempt,
        correlation_id, created_at, updated_at, terminal
      ) VALUES (
        'exec-sigkill', 'state:exec-sigkill', 'tenant-a', 1, 1, 'created',
        'flow:demo', '1.0.0', 'step-a', 0, 0,
        'corr-sigkill', '${now}', '${now}', false
      )`,
    );
    await tx.unsafe(
      `INSERT INTO "${schema}".dispatch_outbox (
        outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch,
        tenant_ref, step_id, definition_id, definition_version, correlation_id,
        work_class_id, priority_class_id, not_before, created_at, superseded
      ) VALUES (
        'outbox:exec-sigkill:1', 'exec-sigkill', 'state:exec-sigkill', 1, 1,
        'tenant-a', 'step-a', 'flow:demo', '1.0.0', 'corr-sigkill',
        'default', 'default', '${now}', '${now}', false
      )`,
    );
    process.stdout.write('READY\n');
    await new Promise(() => {});
  });
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
