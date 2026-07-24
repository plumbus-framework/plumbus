import type { ChatMessage } from '@plumbus/core';
import type { ChatSourceRef } from '../types/context.js';
import type { ToolExecutionRecord } from '../types/tool.js';

export interface ChatPendingActionV2 {
  version: 2;
  id: string;
  sessionId: string;
  expectedSessionRevision: number;

  capabilityName: string;
  /** C3: normalized value only — resolved contract, argumentsStatus 'parsed', Zod-validated,
   *  defaults/coercions applied. Confirm never re-reads input from the client. */
  input: unknown;
  inputSchemaHash: string;
  toolBindingHash: string;
  confirmationMessage: string;
  confirmationProjection?: unknown;

  status:
    | 'pending'
    | 'confirming'
    | 'confirmed'
    | 'rejected'
    | 'expired'
    | 'failed'
    | 'indeterminate';

  attemptId?: string;
  claimedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  expiresAt: string;

  resumePayload: ChatToolResumePayloadV1;
}

export interface ChatToolResumePayloadV1 {
  version: 1;
  chatName: string;
  logicalTurnId: string;
  proposalAssistantTurnId: string;
  toolCallId: string;
  toolName: string;
  messages: ChatMessage[];

  /** All cumulative for the logical turn; resume MUST NOT reset any budget. */
  counters: {
    toolRoundsUsed: number;
    flowStartsUsed: number;
    flowAwaitMsUsed: number;
    inputTokensUsed: number;
    outputTokensUsed: number;
    costUsed: number;
  };

  toolsExecuted: ToolExecutionRecord[];
  sourceRefs: ChatSourceRef[];
  // Serialized ChatToolResumePayloadV1 MUST NOT exceed 256 KiB; overflow fails proposal
  // persistence before emitting confirmation_required.
}

/** Max serialized bytes for a persisted resume payload (C: proposal fails before emit if exceeded). */
export const CHAT_RESUME_PAYLOAD_MAX_BYTES = 256 * 1024;

/** True when the serialized payload is within CHAT_RESUME_PAYLOAD_MAX_BYTES. */
export function resumePayloadWithinLimit(payload: ChatToolResumePayloadV1): boolean {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= CHAT_RESUME_PAYLOAD_MAX_BYTES;
}
