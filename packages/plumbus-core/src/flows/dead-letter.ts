import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { flowDeadLetterTable, flowExecutionsTable } from './schema.js';
import { FlowStatus } from './state-machine.js';

export interface OperatorRetryOptions {
  actor: string;
  reason?: string;
}

export interface OperatorRetryResult {
  executionId: string;
  flowName: string;
  retriedBy: string;
  retriedAt: string;
}

/**
 * Moves failed flow executions to the dead-letter table.
 * Call this after a flow has exhausted retries and entered Failed status.
 */
export async function deadLetterFlow(db: PostgresJsDatabase, executionId: string): Promise<void> {
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

  await db
    .insert(flowDeadLetterTable)
    .values({
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
    })
    .onConflictDoNothing({ target: flowDeadLetterTable.executionId });
}

/**
 * Scans for failed flow executions and moves them to dead-letter.
 * Returns the number of executions moved.
 */
export async function sweepFailedFlows(db: PostgresJsDatabase, limit = 100): Promise<number> {
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

/**
 * Operator recovery: reset a dead-lettered execution so it can run again.
 * Attribution is recorded on the dead-letter row and execution state.
 * Failed → Created is an operator exception (not a normal state-machine edge).
 */
export async function retryDeadLetteredFlow(
  db: PostgresJsDatabase,
  executionId: string,
  opts: OperatorRetryOptions,
): Promise<OperatorRetryResult> {
  if (!opts.actor?.trim()) {
    throw new Error('Operator retry requires an actor');
  }

  const dlqRows = await db
    .select()
    .from(flowDeadLetterTable)
    .where(eq(flowDeadLetterTable.executionId, executionId))
    .limit(1);
  const dlq = dlqRows[0];
  if (!dlq) {
    throw new Error(`Dead-letter row for execution "${executionId}" not found`);
  }

  const existingMeta =
    dlq.metadata && typeof dlq.metadata === 'object' && !Array.isArray(dlq.metadata)
      ? (dlq.metadata as Record<string, unknown>)
      : {};
  if (existingMeta.retriedAt) {
    throw new Error(
      `Execution "${executionId}" was already retried by ${String(existingMeta.retriedBy)}`,
    );
  }

  const execRows = await db
    .select()
    .from(flowExecutionsTable)
    .where(eq(flowExecutionsTable.id, executionId))
    .limit(1);
  const row = execRows[0];
  if (!row) throw new Error(`Flow execution "${executionId}" not found`);

  const retriedAt = new Date().toISOString();
  const attribution = {
    retriedBy: opts.actor,
    retriedAt,
    reason: opts.reason ?? 'operator-retry',
  };
  const priorState =
    row.state && typeof row.state === 'object' && !Array.isArray(row.state)
      ? (row.state as Record<string, unknown>)
      : {};

  await db
    .update(flowExecutionsTable)
    .set({
      status: FlowStatus.Created,
      retryCount: 0,
      lastError: null,
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      state: { ...priorState, __operatorRetry: attribution },
      updatedAt: new Date(),
    })
    .where(eq(flowExecutionsTable.id, executionId));

  await db
    .update(flowDeadLetterTable)
    .set({
      metadata: { ...existingMeta, ...attribution },
    })
    .where(eq(flowDeadLetterTable.executionId, executionId));

  return {
    executionId,
    flowName: row.flowName,
    retriedBy: opts.actor,
    retriedAt,
  };
}
