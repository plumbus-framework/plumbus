// ── Durable deferred flow starts ──
// A flow started inside a capability transaction runs after commit. The intent is written in
// that transaction (`flow_start_intents`), so a process that dies between commit and start
// leaves a row a worker later starts with the same execution id; starting by execution id is
// idempotent, so the post-commit start and the recovery never create two executions.

import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { isPlumbusError } from '../errors/index.js';
import type { LoggerService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import { ErrorCode } from '../types/enums.js';
import { flowAuthSchema } from './execution-record.js';
import { flowStartIntentsTable } from './schema.js';

/** How long after commit the post-commit start has before a worker may start the intent. */
export const FLOW_START_INTENT_GRACE_MS = 30_000;
/** Longest wait between recovery attempts of one intent. */
const MAX_RETRY_DELAY_MS = 300_000;

export interface FlowStartIntent {
  executionId: string;
  flowName: string;
  input: unknown;
  auth: AuthContext;
  attempts: number;
}

const tablePresence = new WeakMap<object, Promise<boolean>>();

/**
 * Whether `flow_start_intents` exists on the database behind `planeDb`, asked once per handle
 * through `probe` (the open transaction: a pool of one has no second connection to lend).
 * A database not yet migrated keeps the earlier, non-durable post-commit start.
 */
export function flowStartIntentsAvailable(
  planeDb: object,
  probe: PostgresJsDatabase,
): Promise<boolean> {
  const cached = tablePresence.get(planeDb);
  if (cached) return cached;
  const presence = (async () => {
    const rows = (await probe.execute(
      sql`SELECT to_regclass('flow_start_intents') IS NOT NULL AS present`,
    )) as unknown as Array<{ present: boolean }>;
    return Array.isArray(rows) && rows[0]?.present === true;
  })();
  tablePresence.set(planeDb, presence);
  // A probe that could not run decides nothing: ask again next time, start non-durably now.
  return presence.catch(() => {
    tablePresence.delete(planeDb);
    return false;
  });
}

/** Write the intent in the caller's transaction. */
export async function writeFlowStartIntent(
  tx: PostgresJsDatabase,
  intent: { executionId: string; flowName: string; input: unknown; auth: AuthContext },
  graceMs: number = FLOW_START_INTENT_GRACE_MS,
): Promise<void> {
  await tx.insert(flowStartIntentsTable).values({
    executionId: intent.executionId,
    flowName: intent.flowName,
    input: intent.input ?? null,
    authSnapshotJson: flowAuthSchema.parse(intent.auth),
    nextAttemptAt: sql`now() + ${`${graceMs} milliseconds`}::interval`,
  });
}

/** The start happened (or can never happen): the intent is done. */
export async function deleteFlowStartIntent(
  db: PostgresJsDatabase,
  executionId: string,
): Promise<void> {
  await db.delete(flowStartIntentsTable).where(eq(flowStartIntentsTable.executionId, executionId));
}

/**
 * Claim intents that are due: each claimed row's `next_attempt_at` moves out by a backoff in
 * the same statement (`SKIP LOCKED`), which keeps other workers off it while this one starts
 * it, and schedules the retry if this one dies or fails.
 */
export async function claimDueFlowStartIntents(
  db: PostgresJsDatabase,
  limit = 20,
): Promise<FlowStartIntent[]> {
  const rows = (await db.execute(sql`
    UPDATE flow_start_intents
    SET attempts = attempts + 1,
        next_attempt_at = now() + make_interval(secs => least(
          ${MAX_RETRY_DELAY_MS / 1000}::double precision,
          ${FLOW_START_INTENT_GRACE_MS / 1000}::double precision * power(2, attempts)
        ))
    WHERE execution_id IN (
      SELECT execution_id FROM flow_start_intents
      WHERE next_attempt_at <= now()
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING execution_id, flow_name, input, auth_snapshot_json, attempts
  `)) as unknown as Record<string, unknown>[];
  const intents: FlowStartIntent[] = [];
  for (const row of rows) {
    const auth = flowAuthSchema.safeParse(row.auth_snapshot_json);
    if (!auth.success) continue;
    intents.push({
      executionId: String(row.execution_id),
      flowName: String(row.flow_name),
      input: row.input,
      auth: auth.data as AuthContext,
      attempts: Number(row.attempts),
    });
  }
  return intents;
}

async function recordFailure(
  db: PostgresJsDatabase,
  executionId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(flowStartIntentsTable)
    .set({ lastError: message.slice(0, 2000) })
    .where(eq(flowStartIntentsTable.executionId, executionId));
}

/** A start that fails the same way whenever it is tried: invalid input for the flow. */
function isPermanentStartFailure(error: unknown): boolean {
  return isPlumbusError(error) && error.code === ErrorCode.Validation;
}

/**
 * Start every due intent on `db` once. `start` must be idempotent by execution id (the flow
 * engine's start is). A start that succeeds deletes the intent; one that fails keeps it for a
 * later attempt (a worker without the flow registered leaves it to one that has it), except
 * invalid input, which is logged and dropped. Returns how many intents were started.
 */
export async function recoverFlowStartIntents(options: {
  db: PostgresJsDatabase;
  start: (intent: FlowStartIntent) => Promise<unknown>;
  logger?: Pick<LoggerService, 'warn' | 'error'>;
  limit?: number;
}): Promise<number> {
  const { db, logger } = options;
  const intents = await claimDueFlowStartIntents(db, options.limit);
  let started = 0;
  for (const intent of intents) {
    try {
      await options.start(intent);
      await deleteFlowStartIntent(db, intent.executionId);
      started += 1;
    } catch (error) {
      if (isPermanentStartFailure(error)) {
        logger?.error('Deferred flow start can never succeed; dropping its intent', {
          executionId: intent.executionId,
          flowName: intent.flowName,
          error: error instanceof Error ? error.message : String(error),
        });
        await deleteFlowStartIntent(db, intent.executionId);
        continue;
      }
      logger?.warn('Deferred flow start failed; retrying later', {
        executionId: intent.executionId,
        flowName: intent.flowName,
        attempts: intent.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      await recordFailure(db, intent.executionId, error);
    }
  }
  return started;
}
