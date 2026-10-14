import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { DataForbiddenError, DataValidationError } from '../errors/index.js';
import { evaluateAccess } from '../execution/index.js';
import type { LoggerService } from '../types/context.js';
import type { EventQueue } from '../events/index.js';
import type { DispatchJobOptions } from './dispatch.js';
import { jobExecutionsTable } from './schema.js';
import { jobEventType } from './types.js';

/** Accepted job IDs refer to committed records, even if the broker is unavailable. */
export async function persistJobIntent(options: DispatchJobOptions): Promise<string> {
  const { capability, auth, db } = options;
  if (capability.kind !== 'job') throw new DataValidationError('Queued target must be a job');
  const access = evaluateAccess(capability.access, auth);
  if (!access.allowed) throw new DataForbiddenError(access.reason ?? 'Job access denied');
  const input = capability.input.safeParse(options.input);
  if (!input.success) throw new DataValidationError('Invalid job input');
  let inputJson: unknown;
  try {
    inputJson = JSON.parse(
      JSON.stringify(input.data, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  } catch {
    throw new DataValidationError('Job input must be JSON serializable');
  }
  if (!capability.input.safeParse(inputJson).success) {
    throw new DataValidationError(
      'Job input schema must accept its JSON representation; use JSON-compatible coercing schemas',
    );
  }
  const id = options.jobId ?? randomUUID();
  if (!z.string().uuid().safeParse(id).success)
    throw new DataValidationError('jobId must be a UUID');
  const inserted = await db
    .insert(jobExecutionsTable)
    .values({
      id,
      capabilityDomain: capability.domain,
      capabilityName: capability.name,
      inputJson,
      authSnapshotJson: auth,
      tenantId: auth.tenantId ?? null,
      correlationId: options.correlationId ?? id,
      source: options.source ?? 'http',
      dispatchPending: true,
    })
    .onConflictDoNothing({ target: jobExecutionsTable.id })
    .returning({ id: jobExecutionsTable.id });
  if (!inserted.length) {
    const [existing] = await db
      .select()
      .from(jobExecutionsTable)
      .where(eq(jobExecutionsTable.id, id));
    const original = z
      .object({ userId: z.string().optional() })
      .passthrough()
      .safeParse(existing?.authSnapshotJson);
    if (
      !existing ||
      !original.success ||
      original.data.userId !== auth.userId ||
      existing.tenantId !== (auth.tenantId ?? null) ||
      existing.capabilityDomain !== capability.domain ||
      existing.capabilityName !== capability.name ||
      !isDeepStrictEqual(existing.inputJson, inputJson)
    ) {
      throw new DataValidationError('Job ID conflicts with an existing request');
    }
  }
  return id;
}

/** Bounded, leased publication recovery. Duplicate wakes retain the same job ID. */
export async function publishPendingJobs(
  db: PostgresJsDatabase,
  queue: EventQueue,
  jobId?: string,
  limit = 50,
  logger: Pick<LoggerService, 'error'> = console,
): Promise<number> {
  const token = randomUUID();
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE job_executions SET dispatch_lease_token = ${token}, dispatch_lease_expires_at = now() + interval '30 seconds'
    WHERE id IN (SELECT id FROM job_executions WHERE dispatch_pending = true AND status = 'queued'
      AND dispatch_after <= now() AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at < now())
      ${jobId ? sql`AND id = ${jobId}` : sql``}
      ORDER BY dispatch_after FOR UPDATE SKIP LOCKED LIMIT ${limit}) RETURNING id
  `);
  let count = 0;
  for (const { id } of claimed) {
    const [row] = await db
      .select()
      .from(jobExecutionsTable)
      .where(and(eq(jobExecutionsTable.id, id), eq(jobExecutionsTable.dispatchLeaseToken, token)));
    if (!row) continue;
    const auth = z
      .object({ userId: z.string().optional() })
      .passthrough()
      .safeParse(row.authSnapshotJson);
    try {
      await queue.publish({
        id,
        eventType: jobEventType(row.capabilityDomain, row.capabilityName),
        version: '1',
        occurredAt: row.createdAt,
        actor: auth.success ? (auth.data.userId ?? 'anonymous') : 'anonymous',
        tenantId: row.tenantId ?? undefined,
        correlationId: row.correlationId ?? id,
        payload: {
          jobExecutionId: id,
          capability: { domain: row.capabilityDomain, name: row.capabilityName },
          input: row.inputJson,
          source: row.source,
        },
      });
      await db
        .update(jobExecutionsTable)
        .set({ dispatchPending: false, dispatchLeaseToken: null, dispatchLeaseExpiresAt: null })
        .where(
          and(eq(jobExecutionsTable.id, id), eq(jobExecutionsTable.dispatchLeaseToken, token)),
        );
      count++;
    } catch {
      logger.error('Job publication pending retry', {
        jobId: id,
        attempt: row.dispatchAttempts + 1,
      });
      await db
        .update(jobExecutionsTable)
        .set({
          dispatchLeaseToken: null,
          dispatchLeaseExpiresAt: null,
          dispatchAttempts: row.dispatchAttempts + 1,
          dispatchAfter: new Date(
            Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.dispatchAttempts, 6)),
          ),
        })
        .where(
          and(eq(jobExecutionsTable.id, id), eq(jobExecutionsTable.dispatchLeaseToken, token)),
        );
    }
  }
  return count;
}
