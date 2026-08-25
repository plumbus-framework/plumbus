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
  executionId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  resolvedAt?: string;
  invalidatedReason?: string;
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
  putRequest(row: ApprovalRequestRecord): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequestRecord | undefined>;
  listRequests(): Promise<ApprovalRequestRecord[]>;
  putDecision(row: ApprovalDecisionRecord): Promise<void>;
  listDecisions(requestId: string): Promise<ApprovalDecisionRecord[]>;
  putTask(row: HumanTaskRecord): Promise<void>;
  getTask(id: string): Promise<HumanTaskRecord | undefined>;
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

export interface CreateHumanTaskInput {
  kind: HumanTaskKind;
  expiresAt: Date | string;
  approvalRequestId?: string;
  executionId?: string;
}

export interface ApprovalService {
  requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestRecord>;
  decide(input: DecideApprovalInput): Promise<ApprovalRequestRecord>;
  findByExecutionId(executionId: string): Promise<ApprovalRequestRecord | undefined>;
  findMatchingApproval(binding: {
    capabilityId: string;
    definitionVersion: string;
    inputDigest: string;
    now?: Date;
  }): Promise<ApprovalRequestRecord | undefined>;
  findConflictingApproval(binding: {
    capabilityId: string;
    definitionVersion: string;
    inputDigest: string;
    now?: Date;
  }): Promise<ApprovalRequestRecord | undefined>;
  invalidateOnMaterialChange(binding: {
    capabilityId: string;
    definitionVersion: string;
    inputDigest: string;
    now?: Date;
  }): Promise<ApprovalRequestRecord[]>;
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
