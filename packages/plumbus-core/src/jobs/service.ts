import { and, eq, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuthContext } from '../types/security.js';
import {
  jobExecutionsTable,
  JobExecutionSource,
  JobExecutionStatus,
  type JobExecutionSource as JobSource,
} from './schema.js';
import type { JobExecutionRecord } from './types.js';

export interface CreateJobExecutionInput {
  id: string;
  capabilityDomain: string;
  capabilityName: string;
  input: Record<string, unknown>;
  auth: AuthContext;
  correlationId?: string;
  source?: JobSource;
}

function rowToRecord(row: typeof jobExecutionsTable.$inferSelect): JobExecutionRecord {
  return {
    id: row.id,
    capabilityDomain: row.capabilityDomain,
    capabilityName: row.capabilityName,
    status: row.status as JobExecutionRecord['status'],
    inputJson: row.inputJson,
    outputJson: row.outputJson,
    errorJson: row.errorJson,
    authSnapshotJson: row.authSnapshotJson as AuthContext | undefined,
    tenantId: row.tenantId,
    correlationId: row.correlationId,
    source: row.source as JobExecutionRecord['source'],
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function getRowsAffected(result: unknown): number {
  const r = result as { rowCount?: unknown; count?: unknown; length?: unknown } | null | undefined;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  if (typeof r?.count === 'number') return r.count;
  if (typeof r?.length === 'number') return r.length;
  return 0;
}

export function createJobService(db: PostgresJsDatabase) {
  return {
    async create(input: CreateJobExecutionInput): Promise<JobExecutionRecord> {
      const [row] = await db
        .insert(jobExecutionsTable)
        .values({
          id: input.id,
          capabilityDomain: input.capabilityDomain,
          capabilityName: input.capabilityName,
          status: JobExecutionStatus.Queued,
          inputJson: input.input,
          authSnapshotJson: input.auth,
          tenantId: input.auth.tenantId ?? null,
          correlationId: input.correlationId ?? input.id,
          source: input.source ?? JobExecutionSource.Http,
        })
        .returning();
      if (!row) {
        throw new Error('Failed to create job execution record');
      }
      return rowToRecord(row);
    },

    async getById(id: string): Promise<JobExecutionRecord | undefined> {
      const rows = await db
        .select()
        .from(jobExecutionsTable)
        .where(eq(jobExecutionsTable.id, id))
        .limit(1);
      const row = rows[0];
      return row ? rowToRecord(row) : undefined;
    },

    /**
     * Atomically transition queued → running. Returns true when this worker won the claim.
     */
    async markRunning(id: string): Promise<boolean> {
      const result = await db
        .update(jobExecutionsTable)
        .set({ status: JobExecutionStatus.Running, startedAt: new Date() })
        .where(
          and(
            eq(jobExecutionsTable.id, id),
            eq(jobExecutionsTable.status, JobExecutionStatus.Queued),
          ),
        );
      const rowsAffected = getRowsAffected(result);
      return rowsAffected > 0;
    },

    /**
     * Reclaim a stale running job after worker crash (visibility timeout exceeded).
     * Returns true when this worker won the reclaim.
     */
    async reclaimStaleRunning(id: string, staleAfterMs: number): Promise<boolean> {
      const cutoff = new Date(Date.now() - staleAfterMs);
      const result = await db
        .update(jobExecutionsTable)
        .set({ startedAt: new Date() })
        .where(
          and(
            eq(jobExecutionsTable.id, id),
            eq(jobExecutionsTable.status, JobExecutionStatus.Running),
            lt(jobExecutionsTable.startedAt, cutoff),
          ),
        );
      return getRowsAffected(result) > 0;
    },

    /**
     * Atomically claim a job for execution, or decide whether to ack or retry delivery.
     */
    async tryClaimForExecution(id: string, staleAfterMs: number): Promise<JobClaimResult> {
      const claimed = await this.markRunning(id);
      if (claimed) {
        return JobClaimResult.Claimed;
      }

      const record = await this.getById(id);
      if (!record) {
        throw new Error(`Job execution "${id}" not found`);
      }

      if (
        record.status === JobExecutionStatus.Completed ||
        record.status === JobExecutionStatus.Failed ||
        record.status === JobExecutionStatus.DeadLettered
      ) {
        return JobClaimResult.Terminal;
      }

      if (record.status === JobExecutionStatus.Running) {
        const startedAt = record.startedAt?.getTime();
        if (startedAt !== undefined && Date.now() - startedAt > staleAfterMs) {
          const reclaimed = await this.reclaimStaleRunning(id, staleAfterMs);
          if (reclaimed) {
            return JobClaimResult.Claimed;
          }
        }
        return JobClaimResult.Retry;
      }

      return JobClaimResult.Retry;
    },

    async markPublishFailed(id: string, error: { code: string; message: string }): Promise<void> {
      await db
        .update(jobExecutionsTable)
        .set({
          status: JobExecutionStatus.Failed,
          errorJson: error,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(jobExecutionsTable.id, id),
            eq(jobExecutionsTable.status, JobExecutionStatus.Queued),
          ),
        );
    },

    async deleteQueued(id: string): Promise<boolean> {
      const result = await db
        .delete(jobExecutionsTable)
        .where(
          and(
            eq(jobExecutionsTable.id, id),
            eq(jobExecutionsTable.status, JobExecutionStatus.Queued),
          ),
        );
      const rowsAffected = getRowsAffected(result);
      return rowsAffected > 0;
    },

    async markCompleted(id: string, output: unknown): Promise<void> {
      await db
        .update(jobExecutionsTable)
        .set({
          status: JobExecutionStatus.Completed,
          outputJson: output,
          completedAt: new Date(),
        })
        .where(eq(jobExecutionsTable.id, id));
    },

    async markFailed(id: string, error: { code: string; message: string }): Promise<void> {
      await db
        .update(jobExecutionsTable)
        .set({
          status: JobExecutionStatus.Failed,
          errorJson: error,
          completedAt: new Date(),
        })
        .where(eq(jobExecutionsTable.id, id));
    },

    async markDeadLettered(id: string, error: { code: string; message: string }): Promise<void> {
      await db
        .update(jobExecutionsTable)
        .set({
          status: JobExecutionStatus.DeadLettered,
          errorJson: error,
          completedAt: new Date(),
        })
        .where(eq(jobExecutionsTable.id, id));
    },
  };
}

export const JobClaimResult = {
  Claimed: 'claimed',
  Terminal: 'terminal',
  Retry: 'retry',
} as const;

export type JobClaimResult = (typeof JobClaimResult)[keyof typeof JobClaimResult];

export type JobService = ReturnType<typeof createJobService>;
