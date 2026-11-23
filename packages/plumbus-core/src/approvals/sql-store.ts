// Tenant-local approval store against an existing Postgres handle.
// Hosts pass the data-plane db (or a resolver that returns it). No new driver.

import { and, asc, desc, eq, gt, inArray, isNull, lte, type SQL, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import { isActionRiskTier } from './action-risk.js';
import type { ReviewMandateReason } from './action-risk.js';
import { assertApprovalPageSize } from './query.js';
import { createTenantApprovalTables } from './schema.js';
import {
  HUMAN_TASK_CONTRACT_VERSION,
  type ApprovalDecisionOutcome,
  type ApprovalDecisionRecord,
  type ApprovalRequestQuery,
  type ApprovalRequestRecord,
  ApprovalRequestState,
  type ApprovalStore,
  type HumanTaskKind,
  type HumanTaskRecord,
  type HumanTaskState,
} from './types.js';

export type ApprovalDbHandle =
  | PostgresJsDatabase
  | (() => PostgresJsDatabase | Promise<PostgresJsDatabase>);

export interface SqlApprovalStoreConfig {
  db: ApprovalDbHandle;
  schemaName?: string;
}

function toDate(value: string): Date {
  return new Date(value);
}

function toIso(value: Date | string): string;
function toIso(value: Date | string | null | undefined): string | undefined;
function toIso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function mapRequest(row: {
  approvalRequestId: string;
  capabilityId: string;
  definitionVersion: string;
  inputDigest: string;
  riskClass: string;
  reviewReason: string;
  state: string;
  tenantId: string | null;
  executionId: string | null;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  invalidatedReason: string | null;
  cancelledByAccountId: string | null;
  cancellationReason: string | null;
}): ApprovalRequestRecord {
  if (!isActionRiskTier(row.riskClass)) {
    throw new Error(`approval_request ${row.approvalRequestId} has unknown risk_class`);
  }
  return {
    contractVersion: HUMAN_TASK_CONTRACT_VERSION,
    approvalRequestId: row.approvalRequestId,
    capabilityId: row.capabilityId,
    definitionVersion: row.definitionVersion,
    inputDigest: row.inputDigest,
    riskClass: row.riskClass,
    reviewReason: row.reviewReason as ReviewMandateReason,
    state: row.state as ApprovalRequestState,
    tenantId: row.tenantId,
    executionId: row.executionId ?? undefined,
    createdAt: toIso(row.createdAt),
    expiresAt: toIso(row.expiresAt),
    updatedAt: toIso(row.updatedAt),
    resolvedAt: toIso(row.resolvedAt),
    invalidatedReason: row.invalidatedReason ?? undefined,
    cancelledByAccountId: row.cancelledByAccountId ?? undefined,
    cancellationReason: row.cancellationReason ?? undefined,
  };
}

function mapDecision(row: {
  approvalDecisionId: string;
  approvalRequestId: string;
  approverAccountId: string;
  decision: string;
  decidedAt: Date;
}): ApprovalDecisionRecord {
  return {
    contractVersion: HUMAN_TASK_CONTRACT_VERSION,
    approvalDecisionId: row.approvalDecisionId,
    approvalRequestId: row.approvalRequestId,
    approverAccountId: row.approverAccountId,
    decision: row.decision as ApprovalDecisionOutcome,
    decidedAt: toIso(row.decidedAt),
  };
}

function mapTask(row: {
  humanTaskId: string;
  kind: string;
  state: string;
  approvalRequestId: string | null;
  executionId: string | null;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}): HumanTaskRecord {
  return {
    contractVersion: HUMAN_TASK_CONTRACT_VERSION,
    humanTaskId: row.humanTaskId,
    kind: row.kind as HumanTaskKind,
    state: row.state as HumanTaskState,
    approvalRequestId: row.approvalRequestId ?? undefined,
    executionId: row.executionId ?? undefined,
    createdAt: toIso(row.createdAt),
    expiresAt: toIso(row.expiresAt),
    updatedAt: toIso(row.updatedAt),
    resolvedAt: toIso(row.resolvedAt),
  };
}

const KNOWN_STATES = new Set<string>(Object.values(ApprovalRequestState));

/** Ids per `expireRequests` statement: far below the protocol's bind-parameter ceiling. */
const EXPIRE_CHUNK = 500;

export function createSqlApprovalStore(config: SqlApprovalStoreConfig): ApprovalStore {
  const tables = createTenantApprovalTables(config.schemaName ?? FRAMEWORK_SCHEMA);
  const request = tables.approvalRequest;

  async function resolveDb(): Promise<PostgresJsDatabase> {
    return typeof config.db === 'function' ? await config.db() : config.db;
  }

  /** The query as SQL. `false` when it can match nothing (an empty `states`). */
  function conditionsOf(query: ApprovalRequestQuery): SQL[] | false {
    const conditions: SQL[] = [];
    if (query.tenantId !== undefined) {
      conditions.push(
        query.tenantId === null ? isNull(request.tenantId) : eq(request.tenantId, query.tenantId),
      );
    }
    if (query.executionId !== undefined) {
      conditions.push(
        query.executionId === null
          ? isNull(request.executionId)
          : eq(request.executionId, query.executionId),
      );
    }
    if (query.capabilityId !== undefined) {
      conditions.push(eq(request.capabilityId, query.capabilityId));
    }
    if (query.definitionVersion !== undefined) {
      conditions.push(eq(request.definitionVersion, query.definitionVersion));
    }
    if (query.inputDigest !== undefined) {
      conditions.push(eq(request.inputDigest, query.inputDigest));
    }
    if (query.states !== undefined) {
      if (query.states.length === 0) return false;
      conditions.push(stateIn(query.states));
    }
    return conditions;
  }

  /**
   * `state IN (...)` with the states as SQL literals: `approval_request_live_idx` is partial on
   * `state IN ('pending', 'approved')`, and Postgres uses a partial index only when it can
   * prove the query implies its predicate, which it cannot do from bind parameters under a
   * generic plan. Each state is checked against the closed set before it is written.
   */
  function stateIn(states: readonly ApprovalRequestState[]): SQL {
    const literals = [...new Set(states)].map((state) => {
      if (!KNOWN_STATES.has(state)) {
        throw new PlumbusError(ErrorCode.Validation, `Unknown approval request state "${state}"`);
      }
      return `'${state}'`;
    });
    return sql`${request.state} IN (${sql.raw(literals.join(', '))})`;
  }

  return {
    async putRequest(row) {
      const db = await resolveDb();
      const values = {
        approvalRequestId: row.approvalRequestId,
        capabilityId: row.capabilityId,
        definitionVersion: row.definitionVersion,
        inputDigest: row.inputDigest,
        riskClass: row.riskClass,
        reviewReason: row.reviewReason,
        state: row.state,
        tenantId: row.tenantId ?? null,
        executionId: row.executionId ?? null,
        createdAt: toDate(row.createdAt),
        expiresAt: toDate(row.expiresAt),
        updatedAt: toDate(row.updatedAt),
        resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
        invalidatedReason: row.invalidatedReason ?? null,
        cancelledByAccountId: row.cancelledByAccountId ?? null,
        cancellationReason: row.cancellationReason ?? null,
      };
      await db
        .insert(tables.approvalRequest)
        .values(values)
        .onConflictDoUpdate({
          target: tables.approvalRequest.approvalRequestId,
          set: {
            capabilityId: values.capabilityId,
            definitionVersion: values.definitionVersion,
            inputDigest: values.inputDigest,
            riskClass: values.riskClass,
            reviewReason: values.reviewReason,
            state: values.state,
            tenantId: values.tenantId,
            executionId: values.executionId,
            expiresAt: values.expiresAt,
            updatedAt: values.updatedAt,
            resolvedAt: values.resolvedAt,
            invalidatedReason: values.invalidatedReason,
            cancelledByAccountId: values.cancelledByAccountId,
            cancellationReason: values.cancellationReason,
          },
        });
    },

    async getRequest(id) {
      const db = await resolveDb();
      const rows = await db
        .select()
        .from(tables.approvalRequest)
        .where(eq(tables.approvalRequest.approvalRequestId, id));
      return rows[0] ? mapRequest(rows[0]) : undefined;
    },

    async getRequests(ids) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const db = await resolveDb();
      const rows = await db
        .select()
        .from(request)
        .where(sql`${request.approvalRequestId} = ANY(${sql.param(unique)}::text[])`);
      return rows.map(mapRequest);
    },

    async listRequests() {
      const db = await resolveDb();
      const rows = await db.select().from(tables.approvalRequest);
      return rows.map(mapRequest);
    },

    async findRequests(query) {
      if (query.limit !== undefined) assertApprovalPageSize(query.limit, 'limit');
      const conditions = conditionsOf(query);
      if (conditions === false) return [];
      const db = await resolveDb();
      const ordered = db
        .select()
        .from(request)
        .where(and(...conditions))
        .orderBy(desc(request.createdAt), desc(request.updatedAt), desc(request.approvalRequestId));
      const rows = query.limit === undefined ? await ordered : await ordered.limit(query.limit);
      return rows.map(mapRequest);
    },

    async listAllRequests({ limit, after }) {
      assertApprovalPageSize(limit, 'limit');
      const db = await resolveDb();
      // Keyset on the primary key: every page is one index range read, however deep.
      const rows = await db
        .select()
        .from(request)
        .where(after === undefined ? undefined : gt(request.approvalRequestId, after))
        .orderBy(asc(request.approvalRequestId))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(mapRequest);
      const last = page[page.length - 1];
      return rows.length > limit && last
        ? { requests: page, next: last.approvalRequestId }
        : { requests: page };
    },

    async expireRequests({ approvalRequestIds, now }) {
      const ids = [...new Set(approvalRequestIds)];
      if (ids.length === 0) return [];
      const db = await resolveDb();
      const at = toDate(now);
      const expired: string[] = [];
      for (let start = 0; start < ids.length; start += EXPIRE_CHUNK) {
        const rows = await db
          .update(request)
          .set({
            state: ApprovalRequestState.Expired,
            updatedAt: at,
            // A raw ISO string with a cast: drizzle's postgres-js driver passes raw params through.
            resolvedAt: sql`coalesce(${request.resolvedAt}, ${at.toISOString()}::timestamptz)`,
          })
          .where(
            and(
              inArray(request.approvalRequestId, ids.slice(start, start + EXPIRE_CHUNK)),
              stateIn([ApprovalRequestState.Pending, ApprovalRequestState.Approved]),
              lte(request.expiresAt, at),
            ),
          )
          .returning({ approvalRequestId: request.approvalRequestId });
        expired.push(...rows.map((row) => row.approvalRequestId));
      }
      return expired;
    },

    async putDecision(row) {
      const db = await resolveDb();
      await db
        .insert(tables.approvalDecision)
        .values({
          approvalDecisionId: row.approvalDecisionId,
          approvalRequestId: row.approvalRequestId,
          approverAccountId: row.approverAccountId,
          decision: row.decision,
          decidedAt: toDate(row.decidedAt),
        })
        .onConflictDoNothing();
    },

    async listDecisions(requestId) {
      const db = await resolveDb();
      const rows = await db
        .select()
        .from(tables.approvalDecision)
        .where(eq(tables.approvalDecision.approvalRequestId, requestId));
      return rows.map(mapDecision);
    },

    async putTask(row) {
      const db = await resolveDb();
      const values = {
        humanTaskId: row.humanTaskId,
        kind: row.kind,
        state: row.state,
        approvalRequestId: row.approvalRequestId ?? null,
        executionId: row.executionId ?? null,
        createdAt: toDate(row.createdAt),
        expiresAt: toDate(row.expiresAt),
        updatedAt: toDate(row.updatedAt),
        resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
      };
      await db
        .insert(tables.humanTask)
        .values(values)
        .onConflictDoUpdate({
          target: tables.humanTask.humanTaskId,
          set: {
            kind: values.kind,
            state: values.state,
            approvalRequestId: values.approvalRequestId,
            executionId: values.executionId,
            expiresAt: values.expiresAt,
            updatedAt: values.updatedAt,
            resolvedAt: values.resolvedAt,
          },
        });
    },

    async getTask(id) {
      const db = await resolveDb();
      const rows = await db
        .select()
        .from(tables.humanTask)
        .where(eq(tables.humanTask.humanTaskId, id));
      return rows[0] ? mapTask(rows[0]) : undefined;
    },

    async listTasksForApprovalRequest(requestId) {
      const db = await resolveDb();
      const rows = await db
        .select()
        .from(tables.humanTask)
        .where(eq(tables.humanTask.approvalRequestId, requestId));
      return rows.map(mapTask);
    },

    async decideRequest(row, decision) {
      const db = await resolveDb();
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(tables.approvalRequest)
          .set({
            state: row.state,
            updatedAt: toDate(row.updatedAt),
            resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
          })
          .where(
            and(
              eq(tables.approvalRequest.approvalRequestId, row.approvalRequestId),
              eq(tables.approvalRequest.state, 'pending'),
            ),
          )
          .returning({ approvalRequestId: tables.approvalRequest.approvalRequestId });
        if (updated.length === 0) return false;
        await tx.insert(tables.approvalDecision).values({
          approvalDecisionId: decision.approvalDecisionId,
          approvalRequestId: decision.approvalRequestId,
          approverAccountId: decision.approverAccountId,
          decision: decision.decision,
          decidedAt: toDate(decision.decidedAt),
        });
        return true;
      });
    },

    async transitionRequest(row, fromStates) {
      if (fromStates.length === 0) return false;
      const db = await resolveDb();
      const updated = await db
        .update(tables.approvalRequest)
        .set({
          state: row.state,
          updatedAt: toDate(row.updatedAt),
          resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
          invalidatedReason: row.invalidatedReason ?? null,
        })
        .where(
          and(
            eq(tables.approvalRequest.approvalRequestId, row.approvalRequestId),
            inArray(tables.approvalRequest.state, [...fromStates]),
          ),
        )
        .returning({ approvalRequestId: tables.approvalRequest.approvalRequestId });
      return updated.length > 0;
    },

    async cancelRequest(row) {
      const db = await resolveDb();
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(tables.approvalRequest)
          .set({
            state: row.state,
            updatedAt: toDate(row.updatedAt),
            resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
            cancelledByAccountId: row.cancelledByAccountId ?? null,
            cancellationReason: row.cancellationReason ?? null,
          })
          .where(
            and(
              eq(tables.approvalRequest.approvalRequestId, row.approvalRequestId),
              eq(tables.approvalRequest.state, 'pending'),
            ),
          )
          .returning({ approvalRequestId: tables.approvalRequest.approvalRequestId });
        if (updated.length === 0) return false;
        await tx
          .update(tables.humanTask)
          .set({
            state: 'cancelled',
            updatedAt: toDate(row.updatedAt),
            resolvedAt: toDate(row.updatedAt),
          })
          .where(
            and(
              eq(tables.humanTask.approvalRequestId, row.approvalRequestId),
              inArray(tables.humanTask.state, ['open', 'claimed']),
            ),
          );
        return true;
      });
    },
  };
}
