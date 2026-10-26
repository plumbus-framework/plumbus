// The claim and retention indexes reach an app the way every framework table change does:
// `collectSchemas` → drizzle-kit snapshot diff (`plumbus migrate generate`) → the framework
// rewriter makes each CREATE INDEX idempotent. An app on the previous snapshot gets exactly
// these statements on its next generate, with the predicates the claim queries match.

import { describe, expect, it } from 'vitest';
import { rewriteFrameworkDriftMigration } from '../framework-migration-rewriter.js';
import { collectSchemas } from '../migration.js';

const NEW_INDEXES = [
  'flow_exec_runnable_idx',
  'flow_exec_finished_idx',
  'flow_schedule_ticks_created_idx',
  'job_exec_dispatch_pending_idx',
  'execution_state_terminal_idx',
  'dispatch_outbox_unpublished_idx',
  'dispatch_outbox_spine_row_idx',
  'dispatch_outbox_acked_idx',
  'side_effect_log_applied_idx',
];

type Snapshot = { tables: Record<string, { indexes: Record<string, unknown> }> };

describe('framework claim and retention indexes in app migrations', () => {
  it('an app on the previous snapshot gets one idempotent CREATE INDEX per new index', async () => {
    const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
    const current = generateDrizzleJson(collectSchemas([])) as unknown as Snapshot;
    // The previous release's snapshot: the same tables without the new indexes.
    const previous = JSON.parse(JSON.stringify(current)) as Snapshot;
    let removed = 0;
    for (const table of Object.values(previous.tables)) {
      for (const name of NEW_INDEXES) {
        if (name in table.indexes) {
          delete table.indexes[name];
          removed += 1;
        }
      }
    }
    expect(removed).toBe(NEW_INDEXES.length);

    const statements = await generateMigration(previous as never, current as never);
    expect(statements).toHaveLength(NEW_INDEXES.length);
    const { statements: rewritten } = rewriteFrameworkDriftMigration(statements, {
      hasDrift: false,
      existingFrameworkTables: [],
      missingFrameworkTables: [],
      tables: [],
    });
    const byName = Object.fromEntries(
      rewritten.map((statement) => [
        /INDEX IF NOT EXISTS "([^"]+)"/.exec(statement)?.[1],
        statement,
      ]),
    );
    expect(Object.keys(byName).sort()).toEqual([...NEW_INDEXES].sort());
    expect(byName.flow_exec_runnable_idx).toContain(
      `ON "flow_executions" USING btree ("created_at") WHERE status IN ('created', 'running', 'waiting')`,
    );
    expect(byName.flow_exec_finished_idx).toContain(
      `("updated_at") WHERE status IN ('completed', 'cancelled')`,
    );
    expect(byName.job_exec_dispatch_pending_idx).toContain(
      `("dispatch_after") WHERE dispatch_pending = true AND status = 'queued'`,
    );
    expect(byName.dispatch_outbox_unpublished_idx).toContain(
      `ON "core_plumbus"."dispatch_outbox" USING btree ("created_at") WHERE published_at IS NULL AND spine_acked_at IS NULL AND superseded = false`,
    );
    expect(byName.dispatch_outbox_spine_row_idx).toContain(
      `("spine_row_id") WHERE spine_acked_at IS NULL`,
    );
    expect(byName.execution_state_terminal_idx).toContain(`("updated_at") WHERE terminal = true`);
  });
});
