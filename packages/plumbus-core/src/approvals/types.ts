import type { AuthContext } from '../types/security.js';
import type { ActionRiskTier, ReviewMandateReason } from './action-risk.js';

export const HUMAN_TASK_CONTRACT_VERSION = '0.1.0' as const;

export const HumanTaskKind = {
  Input: 'input',
  Review: 'review',
  Correction: 'correction',
  Handoff: 'handoff',
  Approval: 'approval',
} as const;
export type HumanTaskKind = (typeof HumanTaskKind)[keyof typeof HumanTaskKind];

export const HumanTaskState = {
  Open: 'open',
  Claimed: 'claimed',
  Completed: 'completed',
  Rejected: 'rejected',
  Expired: 'expired',
  Cancelled: 'cancelled',
  Invalidated: 'invalidated',
} as const;
export type HumanTaskState = (typeof HumanTaskState)[keyof typeof HumanTaskState];

export const ApprovalRequestState = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  ChangesRequested: 'changes-requested',
  Cancelled: 'cancelled',
  Expired: 'expired',
  Invalidated: 'invalidated',
} as const;
export type ApprovalRequestState = (typeof ApprovalRequestState)[keyof typeof ApprovalRequestState];

/** Default human decision outcomes. `expired` is a system state, not a decision. */
export const ApprovalDecisionOutcome = {
  Approved: 'approved',
  Rejected: 'rejected',
  ChangesRequested: 'changes-requested',
} as const;
export type ApprovalDecisionOutcome =
  (typeof ApprovalDecisionOutcome)[keyof typeof ApprovalDecisionOutcome];

/**
 * Tenant-local approval request — v1 field subset of human-task.schema.json.
 * Opaque contract refs (proposal, evidence, policy) are omitted until honestly populated.
 */
export interface ApprovalRequestRecord {
  contractVersion: typeof HUMAN_TASK_CONTRACT_VERSION;
  approvalRequestId: string;
  capabilityId: string;
  definitionVersion: string;
  inputDigest: string;
  riskClass: ActionRiskTier;
  reviewReason: ReviewMandateReason;
  state: ApprovalRequestState;
  /**
   * Tenant the approval was requested for (`null` for an untenanted app).
   * An approval only ever satisfies a gate running for the same tenant.
   */
  tenantId: string | null;
  /**
   * Flow execution the approval was requested for. When set, only that
   * execution's gate can consume it; when unset, only a gate running outside
   * any flow execution can.
   */
  executionId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  resolvedAt?: string;
  invalidatedReason?: string;
  cancelledByAccountId?: string;
  cancellationReason?: string;
}

export interface ApprovalDecisionRecord {
  contractVersion: typeof HUMAN_TASK_CONTRACT_VERSION;
  approvalDecisionId: string;
  approvalRequestId: string;
  approverAccountId: string;
  decision: ApprovalDecisionOutcome;
  decidedAt: string;
}

export interface HumanTaskRecord {
  contractVersion: typeof HUMAN_TASK_CONTRACT_VERSION;
  humanTaskId: string;
  kind: HumanTaskKind;
  state: HumanTaskState;
  approvalRequestId?: string;
  executionId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface ApprovalStore {
  /** Insert a new request (or overwrite one — creation only; state changes use the CAS methods). */
  putRequest(row: ApprovalRequestRecord): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequestRecord | undefined>;
  listRequests(): Promise<ApprovalRequestRecord[]>;
  putDecision(row: ApprovalDecisionRecord): Promise<void>;
  listDecisions(requestId: string): Promise<ApprovalDecisionRecord[]>;
  putTask(row: HumanTaskRecord): Promise<void>;
  getTask(id: string): Promise<HumanTaskRecord | undefined>;
  listTasksForApprovalRequest(requestId: string): Promise<HumanTaskRecord[]>;
  cancelRequest(row: ApprovalRequestRecord): Promise<boolean>;
  /**
   * Record a decision only while the request is still `pending`: the request
   * row is updated with `WHERE state = 'pending'` and the decision row is
   * written in the same transaction. Returns false (writing nothing) when
   * another writer settled the request first.
   */
  decideRequest(row: ApprovalRequestRecord, decision: ApprovalDecisionRecord): Promise<boolean>;
  /**
   * Compare-and-set a system state change (expiry, invalidation): applies only
   * while the stored state is one of `fromStates`. Returns whether it applied.
   */
  transitionRequest(
    row: ApprovalRequestRecord,
    fromStates: readonly ApprovalRequestState[],
  ): Promise<boolean>;
}

export interface AuthorizationRevalidateInput {
  auth: AuthContext;
  capabilityId: string;
  request: ApprovalRequestRecord;
}

export interface AuthorizationProvider {
  revalidate(input: AuthorizationRevalidateInput): Promise<{ allowed: boolean; reason?: string }>;
}

export interface RequestApprovalInput {
  /**
   * Tenant the approval is for — `ctx.auth.tenantId ?? null`. Required so a
   * shared service never creates an approval another tenant can consume.
   */
  tenantId: string | null;
  capabilityId: string;
  definitionVersion: string;
  input: unknown;
  riskClass: ActionRiskTier;
  reviewReason?: ReviewMandateReason;
  expiresAt: Date | string;
  executionId?: string;
}

export interface DecideApprovalInput {
  requestId: string;
  outcome: ApprovalDecisionOutcome;
  auth: AuthContext;
}

export interface CancelApprovalInput {
  requestId: string;
  auth: AuthContext;
  reason: string;
}

export interface CreateHumanTaskInput {
  kind: HumanTaskKind;
  expiresAt: Date | string;
  approvalRequestId?: string;
  executionId?: string;
}

/**
 * Who an approval lookup is for. `tenantId` and `executionId` must equal the
 * values the approval was requested with (`undefined`/`null` only match an
 * approval requested without one).
 */
export interface ApprovalBinding {
  tenantId: string | null;
  executionId?: string | null;
  capabilityId: string;
  definitionVersion: string;
  inputDigest: string;
  now?: Date;
}

export interface ApprovalService {
  requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestRecord>;
  decide(input: DecideApprovalInput): Promise<ApprovalRequestRecord>;
  cancel(input: CancelApprovalInput): Promise<ApprovalRequestRecord>;
  /**
   * Latest approval requested for this flow execution in this tenant. An
   * approved request whose `expiresAt` has passed comes back `expired`.
   */
  findByExecutionId(binding: {
    tenantId: string | null;
    executionId: string;
    now?: Date;
  }): Promise<ApprovalRequestRecord | undefined>;
  findMatchingApproval(binding: ApprovalBinding): Promise<ApprovalRequestRecord | undefined>;
  findConflictingApproval(binding: ApprovalBinding): Promise<ApprovalRequestRecord | undefined>;
  invalidateOnMaterialChange(binding: ApprovalBinding): Promise<ApprovalRequestRecord[]>;
  createHumanTask(input: CreateHumanTaskInput): Promise<HumanTaskRecord>;
  completeHumanTask(input: { taskId: string; auth: AuthContext }): Promise<HumanTaskRecord>;
}

export type ApprovalGateCode =
  | 'prohibited-capability'
  | 'missing-approval'
  | 'missing-approval-service'
  | 'expired-approval'
  | 'input-digest-mismatch'
  | 'definition-mismatch'
  | 'authorization-revalidation-denied';

export type ApprovalGateResult =
  | { blocked: false; request?: ApprovalRequestRecord }
  | {
      blocked: true;
      reason: string;
      code: ApprovalGateCode;
      metadata: Record<string, unknown>;
    };

/**
 * Thrown by `decide` when another decision (or a cancellation, expiry or
 * invalidation) settled the request between the read and the write. The
 * stored state is the winner's; nothing from the losing call was written.
 */
export class ApprovalDecisionConflictError extends Error {
  readonly code = 'approval-decision-conflict' as const;
  constructor(
    readonly approvalRequestId: string,
    readonly currentState: ApprovalRequestState | undefined,
  ) {
    super(
      `Approval request "${approvalRequestId}" was already settled` +
        (currentState ? ` (${currentState})` : '') +
        '; this decision was not applied',
    );
    this.name = 'ApprovalDecisionConflictError';
  }
}
