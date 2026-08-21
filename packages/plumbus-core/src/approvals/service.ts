import { randomUUID } from 'node:crypto';
import { ReviewMandateReason } from './action-risk.js';
import { requireHumanActor } from './actors.js';
import { createAllowAllAuthorizationProvider } from './authorization.js';
import { digestApprovalInput } from './digest.js';
import { createSqlApprovalStore, type ApprovalDbHandle } from './sql-store.js';
import {
  ApprovalRequestState,
  HUMAN_TASK_CONTRACT_VERSION,
  HumanTaskState,
  type ApprovalRequestRecord,
  type ApprovalService,
  type ApprovalStore,
  type AuthorizationProvider,
  type CreateHumanTaskInput,
  type DecideApprovalInput,
  type HumanTaskRecord,
  type RequestApprovalInput,
} from './types.js';

export interface ApprovalServiceConfig {
  /** Memory or SQL store. Required unless `db` is set. */
  store?: ApprovalStore;
  /**
   * Tenant data-plane handle (or a resolver that returns one).
   * Builds a SQL store when `store` is omitted.
   */
  db?: ApprovalDbHandle;
  schemaName?: string;
  authorization?: AuthorizationProvider;
  now?: () => Date;
  id?: () => string;
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

function isPast(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

function resolveStore(config: ApprovalServiceConfig): ApprovalStore {
  if (config.store) {
    return config.store;
  }
  if (config.db) {
    return createSqlApprovalStore({ db: config.db, schemaName: config.schemaName });
  }
  throw new Error('createApprovalService requires store or db');
}

export function createApprovalService(config: ApprovalServiceConfig): ApprovalService {
  const store = resolveStore(config);
  const authorization = config.authorization ?? createAllowAllAuthorizationProvider();
  const nowFn = config.now ?? (() => new Date());
  const idFn = config.id ?? (() => randomUUID());

  async function persistRequest(row: ApprovalRequestRecord): Promise<ApprovalRequestRecord> {
    await store.putRequest(row);
    return { ...row };
  }

  async function expireIfNeeded(
    row: ApprovalRequestRecord,
    now: Date,
  ): Promise<ApprovalRequestRecord> {
    if (row.state === ApprovalRequestState.Pending && isPast(row.expiresAt, now)) {
      return persistRequest({
        ...row,
        state: ApprovalRequestState.Expired,
        updatedAt: now.toISOString(),
        resolvedAt: now.toISOString(),
      });
    }
    if (row.state === ApprovalRequestState.Approved && isPast(row.expiresAt, now)) {
      return persistRequest({
        ...row,
        state: ApprovalRequestState.Expired,
        updatedAt: now.toISOString(),
        resolvedAt: row.resolvedAt ?? now.toISOString(),
      });
    }
    return row;
  }

  async function invalidateMaterialChanges(
    capabilityId: string,
    definitionVersion: string,
    inputDigest: string,
    now: Date,
  ): Promise<void> {
    for (const existing of await store.listRequests()) {
      if (existing.capabilityId !== capabilityId) continue;
      if (existing.inputDigest === inputDigest && existing.definitionVersion === definitionVersion) {
        continue;
      }
      const sameCapability =
        existing.capabilityId === capabilityId &&
        (existing.definitionVersion !== definitionVersion || existing.inputDigest !== inputDigest);
      if (!sameCapability) continue;
      if (
        existing.state !== ApprovalRequestState.Pending &&
        existing.state !== ApprovalRequestState.Approved
      ) {
        continue;
      }
      await persistRequest({
        ...existing,
        state: ApprovalRequestState.Invalidated,
        updatedAt: now.toISOString(),
        resolvedAt: now.toISOString(),
        invalidatedReason: 'material-change',
      });
    }
  }

  return {
    async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestRecord> {
      const now = nowFn();
      const inputDigest = digestApprovalInput(input.input);
      await invalidateMaterialChanges(input.capabilityId, input.definitionVersion, inputDigest, now);
      const createdAt = now.toISOString();
      const row: ApprovalRequestRecord = {
        contractVersion: HUMAN_TASK_CONTRACT_VERSION,
        approvalRequestId: idFn(),
        capabilityId: input.capabilityId,
        definitionVersion: input.definitionVersion,
        inputDigest,
        riskClass: input.riskClass,
        reviewReason: input.reviewReason ?? ReviewMandateReason.RiskTier,
        state: ApprovalRequestState.Pending,
        executionId: input.executionId,
        createdAt,
        expiresAt: toIso(input.expiresAt),
        updatedAt: createdAt,
      };
      return persistRequest(row);
    },

    async decide(input: DecideApprovalInput): Promise<ApprovalRequestRecord> {
      requireHumanActor(input.auth, 'Approval decision');
      const now = nowFn();
      const existing = await store.getRequest(input.requestId);
      if (!existing) {
        throw new Error(`Approval request "${input.requestId}" not found`);
      }
      const current = await expireIfNeeded(existing, now);
      if (current.state !== ApprovalRequestState.Pending) {
        throw new Error(`Approval request "${input.requestId}" is ${current.state}`);
      }

      if (input.outcome === 'approved') {
        const check = await authorization.revalidate({
          auth: input.auth,
          capabilityId: current.capabilityId,
          request: current,
        });
        if (!check.allowed) {
          throw new Error(check.reason ?? 'authorization revalidation denied');
        }
      }

      const decidedAt = now.toISOString();
      await store.putDecision({
        contractVersion: HUMAN_TASK_CONTRACT_VERSION,
        approvalDecisionId: idFn(),
        approvalRequestId: current.approvalRequestId,
        approverAccountId: input.auth.userId as string,
        decision: input.outcome,
        decidedAt,
      });

      return persistRequest({
        ...current,
        state: input.outcome,
        updatedAt: decidedAt,
        resolvedAt: decidedAt,
      });
    },

    async findByExecutionId(executionId: string) {
      const matches = (await store.listRequests())
        .filter((row) => row.executionId === executionId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return matches[0];
    },

    async findMatchingApproval(binding) {
      const now = binding.now ?? nowFn();
      let match: ApprovalRequestRecord | undefined;
      let expired: ApprovalRequestRecord | undefined;
      for (const row of await store.listRequests()) {
        if (row.capabilityId !== binding.capabilityId) continue;
        if (row.definitionVersion !== binding.definitionVersion) continue;
        if (row.inputDigest !== binding.inputDigest) continue;
        const current = await expireIfNeeded(row, now);
        if (current.state === ApprovalRequestState.Approved) {
          match = current;
        } else if (current.state === ApprovalRequestState.Expired) {
          expired = current;
        }
      }
      return match ?? expired;
    },

    async findConflictingApproval(binding) {
      const now = binding.now ?? nowFn();
      for (const row of await store.listRequests()) {
        if (row.capabilityId !== binding.capabilityId) continue;
        const current = await expireIfNeeded(row, now);
        if (
          current.state !== ApprovalRequestState.Pending &&
          current.state !== ApprovalRequestState.Approved
        ) {
          continue;
        }
        if (
          current.definitionVersion !== binding.definitionVersion ||
          current.inputDigest !== binding.inputDigest
        ) {
          return current;
        }
      }
      return undefined;
    },

    async invalidateOnMaterialChange(binding) {
      const now = binding.now ?? nowFn();
      const before = await store.listRequests();
      await invalidateMaterialChanges(
        binding.capabilityId,
        binding.definitionVersion,
        binding.inputDigest,
        now,
      );
      return (await store.listRequests()).filter(
        (row) =>
          row.state === ApprovalRequestState.Invalidated &&
          !before.find(
            (prior) =>
              prior.approvalRequestId === row.approvalRequestId &&
              prior.state === ApprovalRequestState.Invalidated,
          ),
      );
    },

    async createHumanTask(input: CreateHumanTaskInput): Promise<HumanTaskRecord> {
      const now = nowFn();
      const createdAt = now.toISOString();
      const row = {
        contractVersion: HUMAN_TASK_CONTRACT_VERSION,
        humanTaskId: idFn(),
        kind: input.kind,
        state: HumanTaskState.Open,
        approvalRequestId: input.approvalRequestId,
        executionId: input.executionId,
        createdAt,
        expiresAt: toIso(input.expiresAt),
        updatedAt: createdAt,
      };
      await store.putTask(row);
      return { ...row };
    },

    async completeHumanTask(input) {
      requireHumanActor(input.auth, 'Human task completion');
      const now = nowFn();
      const existing = await store.getTask(input.taskId);
      if (!existing) {
        throw new Error(`Human task "${input.taskId}" not found`);
      }
      if (existing.state !== HumanTaskState.Open && existing.state !== HumanTaskState.Claimed) {
        throw new Error(`Human task "${input.taskId}" is ${existing.state}`);
      }
      if (isPast(existing.expiresAt, now)) {
        const expired = {
          ...existing,
          state: HumanTaskState.Expired,
          updatedAt: now.toISOString(),
          resolvedAt: now.toISOString(),
        };
        await store.putTask(expired);
        throw new Error(`Human task "${input.taskId}" is expired`);
      }
      const completed = {
        ...existing,
        state: HumanTaskState.Completed,
        updatedAt: now.toISOString(),
        resolvedAt: now.toISOString(),
      };
      await store.putTask(completed);
      return { ...completed };
    },
  };
}
