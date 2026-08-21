// Tenant-local approval store against an existing Postgres handle.
// Hosts pass the data-plane db (or a resolver that returns it). No new driver.

import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { isActionRiskTier } from './action-risk.js';
import type { ReviewMandateReason } from './action-risk.js';
import { createTenantApprovalTables } from './schema.js';
import {
  HUMAN_TASK_CONTRACT_VERSION,
  type ApprovalDecisionOutcome,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalRequestState,
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
  executionId: string | null;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  invalidatedReason: string | null;
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
    executionId: row.executionId ?? undefined,
    createdAt: toIso(row.createdAt)!,
    expiresAt: toIso(row.expiresAt)!,
    updatedAt: toIso(row.updatedAt)!,
    resolvedAt: toIso(row.resolvedAt),
    invalidatedReason: row.invalidatedReason ?? undefined,
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
    decidedAt: toIso(row.decidedAt)!,
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
    createdAt: toIso(row.createdAt)!,
    expiresAt: toIso(row.expiresAt)!,
    updatedAt: toIso(row.updatedAt)!,
    resolvedAt: toIso(row.resolvedAt),
  };
}

export function createSqlApprovalStore(config: SqlApprovalStoreConfig): ApprovalStore {
  const tables = createTenantApprovalTables(config.schemaName ?? FRAMEWORK_SCHEMA);

  async function resolveDb(): Promise<PostgresJsDatabase> {
    return typeof config.db === 'function' ? await config.db() : config.db;
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
        executionId: row.executionId ?? null,
        createdAt: toDate(row.createdAt),
        expiresAt: toDate(row.expiresAt),
        updatedAt: toDate(row.updatedAt),
        resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
        invalidatedReason: row.invalidatedReason ?? null,
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
            executionId: values.executionId,
            expiresAt: values.expiresAt,
            updatedAt: values.updatedAt,
            resolvedAt: values.resolvedAt,
            invalidatedReason: values.invalidatedReason,
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

    async listRequests() {
      const db = await resolveDb();
      const rows = await db.select().from(tables.approvalRequest);
      return rows.map(mapRequest);
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
      const rows = await db.select().from(tables.humanTask).where(eq(tables.humanTask.humanTaskId, id));
      return rows[0] ? mapTask(rows[0]) : undefined;
    },
  };
}
