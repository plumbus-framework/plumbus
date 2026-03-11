import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { flowDeadLetterTable, flowExecutionsTable } from "./schema.js";
import { FlowStatus } from "./state-machine.js";

/**
 * Moves failed flow executions to the dead-letter table.
 * Call this after a flow has exhausted retries and entered Failed status.
 */
export async function deadLetterFlow(
  db: PostgresJsDatabase,
  executionId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(flowExecutionsTable)
    .where(eq(flowExecutionsTable.id, executionId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`Flow execution "${executionId}" not found`);

  if (row.status !== FlowStatus.Failed) {
    throw new Error(
      `Cannot dead-letter flow "${executionId}" — status is "${row.status}", expected "failed"`,
    );
  }

  await db.insert(flowDeadLetterTable).values({
    executionId: row.id,
    flowName: row.flowName,
    input: row.input as any,
    state: row.state as any,
    stepHistory: row.stepHistory as any,
    lastError: row.lastError,
    retryCount: row.retryCount,
    metadata: {
      actor: row.actor,
      tenantId: row.tenantId,
      correlationId: row.correlationId,
      triggerEventId: row.triggerEventId,
      createdAt: row.createdAt?.toISOString(),
      failedAt: row.completedAt?.toISOString(),
    },
  });
}

/**
 * Scans for failed flow executions and moves them to dead-letter.
 * Returns the number of executions moved.
 */
export async function sweepFailedFlows(
  db: PostgresJsDatabase,
  limit = 100,
): Promise<number> {
  const failedRows = await db
    .select({ id: flowExecutionsTable.id })
    .from(flowExecutionsTable)
    .where(eq(flowExecutionsTable.status, FlowStatus.Failed))
    .limit(limit);

  let moved = 0;
  for (const row of failedRows) {
    try {
      await deadLetterFlow(db, row.id);
      moved++;
    } catch {
      // Skip rows that fail to move — will be retried next sweep
    }
  }

  return moved;
}
