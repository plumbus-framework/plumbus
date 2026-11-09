import { randomUUID } from 'node:crypto';
import { ActionRiskTier, ReviewMandateReason } from './action-risk.js';
import { requireHumanActor } from './actors.js';
import { digestApprovalInput } from './digest.js';
import { createSqlApprovalStore, type ApprovalDbHandle } from './sql-store.js';
import {
  ApprovalDecisionConflictError,
  ApprovalDecisionOutcome,
  ApprovalRequestState,
  HUMAN_TASK_CONTRACT_VERSION,
  HumanTaskState,
  type ApprovalBinding,
  type ApprovalRequestRecord,
  type ApprovalService,
  type ApprovalStore,
  type AuthorizationProvider,
  type CancelApprovalInput,
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
  /**
   * Decides who may approve, reject, request changes on, or cancel a request.
   * Required for any decision: with no provider, `decide` and `cancel` refuse
   * (fail closed). Pass `createAllowAllAuthorizationProvider()` only to opt
   * out of authorization explicitly (tests, single-operator tools).
   */
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

const DECISION_OUTCOMES = new Set<string>(Object.values(ApprovalDecisionOutcome));

/** Tenant + execution the approval was requested for must equal the caller's. */
function sameSubject(
  row: ApprovalRequestRecord,
  binding: { tenantId: string | null; executionId?: string | null },
): boolean {
  return (
    (row.tenantId ?? null) === (binding.tenantId ?? null) &&
    (row.executionId ?? null) === (binding.executionId ?? null)
  );
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
  const authorization = config.authorization;
  const nowFn = config.now ?? (() => new Date());
  const idFn = config.id ?? (() => randomUUID());

  /** Every decision type and cancellation goes through this one check. */
  async function authorize(
    action: string,
    auth: DecideApprovalInput['auth'],
    request: ApprovalRequestRecord,
  ): Promise<void> {
    if (!authorization) {
      throw new Error(
        `${action} refused: createApprovalService has no authorization provider. ` +
          'Pass `authorization` (or createAllowAllAuthorizationProvider() to opt out explicitly).',
      );
    }
    const check = await authorization.revalidate({
      auth,
      capabilityId: request.capabilityId,
      request,
    });
    if (!check.allowed) {
      throw new Error(check.reason ?? 'authorization revalidation denied');
    }
  }

  /**
   * Pending or approved past `expiresAt` is expired. The state change is a
   * compare-and-set; whatever the store ends up holding, an approval past its
   * expiry is never returned as `approved`.
   */
  async function expireIfNeeded(
    row: ApprovalRequestRecord,
    now: Date,
  ): Promise<ApprovalRequestRecord> {
    const live =
      row.state === ApprovalRequestState.Pending || row.state === ApprovalRequestState.Approved;
    if (!live || !isPast(row.expiresAt, now)) {
      return row;
    }
    const expired: ApprovalRequestRecord = {
      ...row,
      state: ApprovalRequestState.Expired,
      updatedAt: now.toISOString(),
      resolvedAt: row.resolvedAt ?? now.toISOString(),
    };
    if (await store.transitionRequest(expired, [row.state])) {
      return { ...expired };
    }
    const fresh = await store.getRequest(row.approvalRequestId);
    if (!fresh) return { ...expired };
    if (
      (fresh.state === ApprovalRequestState.Pending ||
        fresh.state === ApprovalRequestState.Approved) &&
      isPast(fresh.expiresAt, now)
    ) {
      return { ...fresh, state: ApprovalRequestState.Expired };
    }
    return fresh;
  }

  /**
   * A new request (or a gate call) for the same subject and capability with a
   * different definition version or input digest invalidates the live ones.
   * Scoped to the same tenant and execution — another tenant's request never
   * touches this tenant's approvals.
   */
  async function invalidateMaterialChanges(
    binding: ApprovalBinding,
    now: Date,
  ): Promise<ApprovalRequestRecord[]> {
    const invalidated: ApprovalRequestRecord[] = [];
    for (const existing of await store.listRequests()) {
      if (existing.capabilityId !== binding.capabilityId) continue;
      if (!sameSubject(existing, binding)) continue;
      if (
        existing.inputDigest === binding.inputDigest &&
        existing.definitionVersion === binding.definitionVersion
      ) {
        continue;
      }
      if (
        existing.state !== ApprovalRequestState.Pending &&
        existing.state !== ApprovalRequestState.Approved
      ) {
        continue;
      }
      const next: ApprovalRequestRecord = {
        ...existing,
        state: ApprovalRequestState.Invalidated,
        updatedAt: now.toISOString(),
        resolvedAt: now.toISOString(),
        invalidatedReason: 'material-change',
      };
      if (await store.transitionRequest(next, [existing.state])) {
        invalidated.push({ ...next });
      }
    }
    return invalidated;
  }

  return {
    async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestRecord> {
      // A prohibited action cannot be proposed for approval: creating the
      // request must not make the action permissible.
      if (input.riskClass === ActionRiskTier.Prohibited) {
        throw new Error(
          `Approval cannot be requested for prohibited capability "${input.capabilityId}"`,
        );
      }
      if (
        input.tenantId === undefined ||
        (input.tenantId !== null && (typeof input.tenantId !== 'string' || input.tenantId === ''))
      ) {
        throw new Error(
          'requestApproval requires tenantId (the requesting tenant, or null for an untenanted app)',
        );
      }
      const now = nowFn();
      const inputDigest = digestApprovalInput(input.input);
      await invalidateMaterialChanges(
        {
          tenantId: input.tenantId,
          executionId: input.executionId,
          capabilityId: input.capabilityId,
          definitionVersion: input.definitionVersion,
          inputDigest,
        },
        now,
      );
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
        tenantId: input.tenantId,
        executionId: input.executionId,
        createdAt,
        expiresAt: toIso(input.expiresAt),
        updatedAt: createdAt,
      };
      await store.putRequest(row);
      return { ...row };
    },

    async decide(input: DecideApprovalInput): Promise<ApprovalRequestRecord> {
      requireHumanActor(input.auth, 'Approval decision');
      if (!DECISION_OUTCOMES.has(input.outcome)) {
        throw new Error(`Unknown approval decision outcome "${String(input.outcome)}"`);
      }
      const now = nowFn();
      const existing = await store.getRequest(input.requestId);
      if (!existing) {
        throw new Error(`Approval request "${input.requestId}" not found`);
      }
      const current = await expireIfNeeded(existing, now);
      if (current.state !== ApprovalRequestState.Pending) {
        throw new Error(`Approval request "${input.requestId}" is ${current.state}`);
      }

      await authorize('Approval decision', input.auth, current);

      const decidedAt = now.toISOString();
      const decided: ApprovalRequestRecord = {
        ...current,
        state: input.outcome,
        updatedAt: decidedAt,
        resolvedAt: decidedAt,
      };
      const applied = await store.decideRequest(decided, {
        contractVersion: HUMAN_TASK_CONTRACT_VERSION,
        approvalDecisionId: idFn(),
        approvalRequestId: current.approvalRequestId,
        approverAccountId: input.auth.userId as string,
        decision: input.outcome,
        decidedAt,
      });
      if (!applied) {
        const winner = await store.getRequest(current.approvalRequestId);
        throw new ApprovalDecisionConflictError(current.approvalRequestId, winner?.state);
      }
      return { ...decided };
    },

    async cancel(input: CancelApprovalInput): Promise<ApprovalRequestRecord> {
      requireHumanActor(input.auth, 'Approval cancellation');
      const reason = input.reason.trim();
      if (reason.length === 0 || reason.length > 500) {
        throw new Error('Approval cancellation reason must contain 1 to 500 characters');
      }
      const now = nowFn();
      const existing = await store.getRequest(input.requestId);
      if (!existing) throw new Error(`Approval request "${input.requestId}" not found`);
      const current = await expireIfNeeded(existing, now);
      if (current.state !== ApprovalRequestState.Pending) {
        throw new Error(`Approval request "${input.requestId}" is ${current.state}`);
      }
      await authorize('Approval cancellation', input.auth, current);

      const cancelledAt = now.toISOString();
      const cancelled: ApprovalRequestRecord = {
        ...current,
        state: ApprovalRequestState.Cancelled,
        updatedAt: cancelledAt,
        resolvedAt: cancelledAt,
        cancelledByAccountId: input.auth.userId as string,
        cancellationReason: reason,
      };
      if (!(await store.cancelRequest(cancelled))) {
        const winner = await store.getRequest(current.approvalRequestId);
        throw new Error(
          `Approval request "${input.requestId}" is ${winner?.state ?? 'no longer pending'}`,
        );
      }
      return { ...cancelled };
    },

    async findByExecutionId(binding) {
      const now = binding.now ?? nowFn();
      const latest = (await store.listRequests())
        .filter((row) => sameSubject(row, binding))
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt),
        )[0];
      return latest ? expireIfNeeded(latest, now) : undefined;
    },

    async findMatchingApproval(binding) {
      const now = binding.now ?? nowFn();
      let match: ApprovalRequestRecord | undefined;
      let expired: ApprovalRequestRecord | undefined;
      for (const row of await store.listRequests()) {
        if (!sameSubject(row, binding)) continue;
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
        if (!sameSubject(row, binding)) continue;
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
      return invalidateMaterialChanges(binding, binding.now ?? nowFn());
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
