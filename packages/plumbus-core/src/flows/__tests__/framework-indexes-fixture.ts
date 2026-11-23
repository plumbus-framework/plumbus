// The framework-table indexes core 0.9.0-beta.15 adds, and the framework snapshot an app had
// before them: shared by framework-indexes.test.ts and framework-indexes.pg.test.ts.

import { rewriteFrameworkDriftMigration } from '../../data/framework-migration-rewriter.js';
import { collectSchemas } from '../../data/migration.js';

/** Index name → what its generated statement must say. */
export const ADDED_FRAMEWORK_INDEXES: Record<string, string[]> = {
  flow_exec_failed_idx: ['"flow_executions"', '"updated_at"', `WHERE status = 'failed'`],
  flow_exec_updated_idx: [
    '"flow_executions"',
    '"updated_at" DESC NULLS FIRST',
    '"id" DESC NULLS FIRST',
  ],
  event_outbox_dispatched_idx: ['"event_outbox"', '"dispatched_at"', `WHERE status = 'dispatched'`],
  event_idempotency_processed_idx: ['"event_idempotency"', '"processed_at"'],
  event_dead_letter_unresolved_idx: [
    '"event_dead_letter"',
    '"event_id"',
    `WHERE (metadata->>'resolvedAt') IS NULL`,
  ],
  event_dead_letter_resolved_idx: [
    '"event_dead_letter"',
    `("metadata"->>'resolvedAt')`,
    `WHERE (metadata->>'resolvedAt') IS NOT NULL`,
  ],
  job_exec_finished_idx: [
    '"job_executions"',
    '"completed_at"',
    `WHERE status IN ('completed', 'failed', 'dead_lettered')`,
  ],
};

type Snapshot = { tables: Record<string, { indexes: Record<string, unknown> }> };

/** The framework snapshot as an app generated it before these indexes existed. */
export async function previousFrameworkSnapshot(): Promise<{
  previous: Snapshot;
  current: Snapshot;
}> {
  const { generateDrizzleJson } = await import('drizzle-kit/api');
  const current = generateDrizzleJson(collectSchemas([])) as unknown as Snapshot;
  const previous = JSON.parse(JSON.stringify(current)) as Snapshot;
  for (const table of Object.values(previous.tables)) {
    for (const name of Object.keys(ADDED_FRAMEWORK_INDEXES)) delete table.indexes[name];
  }
  return { previous, current };
}

/** What `plumbus migrate generate` writes for an app on the previous snapshot. */
export async function generatedIndexStatements(): Promise<string[]> {
  const { generateMigration } = await import('drizzle-kit/api');
  const { previous, current } = await previousFrameworkSnapshot();
  const statements = await generateMigration(previous as never, current as never);
  return rewriteFrameworkDriftMigration(statements, {
    hasDrift: false,
    existingFrameworkTables: [],
    missingFrameworkTables: [],
    tables: [],
  }).statements;
}
