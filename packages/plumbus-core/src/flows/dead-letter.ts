import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';
import type { FlowRegistry } from './registry.js';
import { createFlowExecutionRecord, flowAuthSchema } from './execution-record.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import {
  type DispatchOutboxRow,
  insertDispatchOutbox,
  persistAcceptanceOnDb,
  publishOutboxToSpine,
  reopenExecutionState,
} from '../durable/index.js';
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
  /**
   * Under spine dispatch: whether a fresh dispatch hint was published for the reopened
   * execution. False when the plane holds no durable state for it (a row started before
   * tenant placement, or a control-plane flow the worker claims from its own table).
   */
  republished?: boolean;
}

/**
 * Where a tenant-placed execution's hints go (#137). A row on a tenant plane is only ever
 * run when the spine holds a ready hint for it; a terminal execution has none, so an operator
 * retry must publish a fresh one or the reset row sits `created` forever.
 */
export interface OperatorRetryPlacement {
  /** The spine's connection, where `opaque_dispatch` lives. */
  spineDb: PostgresJsDatabase;
  /** The plane's framework schema (`core_plumbus` by default). */
  coreSchema?: string;
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
    .where(
      and(
        eq(flowExecutionsTable.status, FlowStatus.Failed),
        sql`NOT EXISTS (SELECT 1 FROM ${flowDeadLetterTable} WHERE ${flowDeadLetterTable.executionId} = ${flowExecutionsTable.id}::text)`,
      ),
    )
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
 *
 * The guards, the reset and the attribution commit in one transaction that holds the dead
 * letter `FOR UPDATE` — the lock `replayDeadLetterFlow` takes — so an in-place retry and a
 * replay of the same failure serialise: whichever commits second is refused (the replay sees a
 * source that is no longer failed; the retry sees the recorded `replayExecutionId`).
 */
export async function retryDeadLetteredFlow(
  db: PostgresJsDatabase,
  executionId: string,
  opts: OperatorRetryOptions,
  placement?: OperatorRetryPlacement,
): Promise<OperatorRetryResult> {
  if (!opts.actor?.trim()) {
    throw new Error('Operator retry requires an actor');
  }
  const schemaName = placement?.coreSchema ?? FRAMEWORK_SCHEMA;

  const reset = await db.transaction(async (txn) => {
    const tx = txn as unknown as PostgresJsDatabase;
    const [dlq] = await tx
      .select()
      .from(flowDeadLetterTable)
      .where(eq(flowDeadLetterTable.executionId, executionId))
      .for('update');
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
    if (existingMeta.replayExecutionId) {
      throw new Error(
        `Execution "${executionId}" was already replayed as "${String(existingMeta.replayExecutionId)}"`,
      );
    }

    const [row] = await tx
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);
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

    // Fenced on `failed`: a row a worker or another operator already moved on is not reset.
    const updated = await tx
      .update(flowExecutionsTable)
      .set({
        status: FlowStatus.Created,
        retryCount: 0,
        lastError: null,
        completedAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        waitKind: null,
        state: { ...priorState, __operatorRetry: attribution },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          eq(flowExecutionsTable.status, FlowStatus.Failed),
        ),
      )
      .returning({ id: flowExecutionsTable.id });
    if (updated.length === 0) {
      throw new Error(
        row.status === FlowStatus.Failed
          ? `Execution "${executionId}" is no longer failed (it changed during the retry)`
          : `Execution "${executionId}" is no longer failed (status "${row.status}")`,
      );
    }

    await tx
      .update(flowDeadLetterTable)
      .set({
        metadata: { ...existingMeta, ...attribution },
      })
      .where(eq(flowDeadLetterTable.executionId, executionId));

    // Under spine dispatch: reopen the durable state and record its dispatch outbox row with
    // the reset, so a committed reset always has a hint to publish (the dispatcher's outbox
    // pump publishes it should the spine hand-off below fail). A plane without state for this
    // execution has nothing to reopen: the row is claimed from its own table as before.
    let outbox: DispatchOutboxRow | undefined;
    let revision: number | undefined;
    if (placement) {
      const reopened = await reopenExecutionState(
        tx,
        { executionId, stepId: row.currentStep ?? '', nowIso: retriedAt },
        schemaName,
      );
      if (reopened) {
        outbox = await insertDispatchOutbox(
          tx,
          reopened,
          reopened.currentStepId,
          retriedAt,
          schemaName,
        );
        revision = reopened.revision;
      }
    }
    return { row, retriedAt, outbox, revision };
  });

  let republished = false;
  if (placement && reset.outbox && reset.revision !== undefined) {
    // After commit: hand the spine a fresh hint, so a worker claims the reset row again.
    await publishOutboxToSpine(
      db,
      placement.spineDb,
      reset.outbox,
      `disp:${executionId}:${reset.revision}`,
      reset.retriedAt,
      schemaName,
    );
    republished = true;
  }

  return {
    executionId,
    flowName: reset.row.flowName,
    retriedBy: opts.actor,
    retriedAt: reset.retriedAt,
    republished,
  };
}

export interface ReplayDeadLetterOptions {
  /** Operator recorded on the dead letter as `replayedBy`. */
  actor?: string;
  /** Recorded on the dead letter as `replayReason`. */
  reason?: string;
  /**
   * Under spine dispatch: where the replay's hint goes. A tenant-placed replay gets its
   * acceptance (durable state + outbox row) in the replay transaction and a spine hint after
   * commit; without one the row on a tenant plane would never be claimed.
   */
  placement?: OperatorRetryPlacement;
}

/** Replay the failed step as a new execution; the original remains terminal. */
export async function replayDeadLetterFlow(
  db: PostgresJsDatabase,
  registry: FlowRegistry,
  executionId: string,
  options: ReplayDeadLetterOptions = {},
): Promise<string> {
  const schemaName = options.placement?.coreSchema ?? FRAMEWORK_SCHEMA;
  const replayed: { id: string; outbox?: DispatchOutboxRow; nowIso?: string } =
    await db.transaction(async (tx) => {
      const [deadLetter] = await tx
        .select()
        .from(flowDeadLetterTable)
        .where(eq(flowDeadLetterTable.executionId, executionId))
        .for('update');
      if (!deadLetter) throw new DataValidationError('Flow dead letter not found', { executionId });
      const metadata = z.record(z.string(), z.unknown()).parse(deadLetter.metadata ?? {});
      const previous = z.string().guid().safeParse(metadata.replayExecutionId);
      if (previous.success) return { id: previous.data };
      const [row] = await tx
        .select()
        .from(flowExecutionsTable)
        .where(eq(flowExecutionsTable.id, executionId));
      if (!row || row.status !== FlowStatus.Failed)
        throw new DataValidationError('Replay requires a failed source execution');
      const auth = flowAuthSchema.safeParse(row.authSnapshotJson);
      if (
        !auth.success ||
        (auth.data.tenantId ?? null) !== row.tenantId ||
        (auth.data.userId != null && auth.data.userId !== row.actor)
      ) {
        throw new DataValidationError('Replay requires the original verified caller identity');
      }
      const flow = registry.get(row.flowName);
      if (!flow || !flow.steps.some((step) => step.name === row.currentStep))
        throw new DataValidationError('Failed step is absent from the current flow definition');
      if (flow.state && !flow.state.safeParse(row.state).success)
        throw new DataValidationError(
          'Stored state is incompatible with the current flow definition',
        );
      const replay = await createFlowExecutionRecord(
        tx as unknown as PostgresJsDatabase,
        flow,
        row.input,
        auth.data,
        {
          correlationId: row.correlationId ?? undefined,
          triggerEventId: executionId,
          scheduleId: row.scheduleId ?? undefined,
        },
      );
      // The replay runs on the source's pinned definition (a compiled deployment resolves it by pin).
      await tx
        .update(flowExecutionsTable)
        .set({
          currentStep: row.currentStep,
          state: row.state,
          replayOf: row.id,
          definitionVersion: row.definitionVersion,
          definitionDigest: row.definitionDigest,
        })
        .where(eq(flowExecutionsTable.id, replay.id));
      const nowIso = new Date().toISOString();
      let outbox: DispatchOutboxRow | undefined;
      if (options.placement && row.tenantId) {
        outbox = (
          await persistAcceptanceOnDb(
            tx as unknown as PostgresJsDatabase,
            {
              executionId: replay.id,
              tenantRef: row.tenantId,
              definitionId: row.flowName,
              definitionVersion: row.definitionVersion ?? '0.0.0',
              firstStepId: row.currentStep ?? 'terminal',
              correlationId: row.correlationId ?? replay.id,
              nowIso,
            },
            schemaName,
          )
        ).outbox;
      }
      await tx
        .update(flowDeadLetterTable)
        .set({
          metadata: {
            ...metadata,
            replayExecutionId: replay.id,
            replayedAt: nowIso,
            replaySource: 'operator',
            ...(options.actor ? { replayedBy: options.actor } : {}),
            ...(options.reason ? { replayReason: options.reason } : {}),
          },
        })
        .where(eq(flowDeadLetterTable.id, deadLetter.id));
      return { id: replay.id, outbox, nowIso };
    });
  if (options.placement && replayed.outbox && replayed.nowIso) {
    // After commit: hand the spine the replay's hint. A failure propagates; the recorded replay
    // id is returned by a repeated call and the dispatcher's outbox pump publishes the row.
    await publishOutboxToSpine(
      db,
      options.placement.spineDb,
      replayed.outbox,
      `disp:${replayed.id}:1`,
      replayed.nowIso,
      schemaName,
    );
  }
  return replayed.id;
}
