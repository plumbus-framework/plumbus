import type { ExecutionContext, RegisteredCapabilityName } from '@plumbus/core';
import type { ChatPendingActionV2, ChatToolResumePayloadV1 } from '../session/pending-action-v2.js';
import { resumePayloadWithinLimit } from '../session/pending-action-v2.js';
import { capabilityActionHashV2 } from './action-schema-hash.js';

export interface BuildNormalizedPendingArgs {
  ctx: ExecutionContext;
  sessionId: string;
  expectedSessionRevision: number;
  capabilityName: string;
  /** Raw, un-normalized arguments from the model/legacy requestedAction. */
  rawInput: unknown;
  confirmationMessage: string;
  /** Schema-only hash from the bound tool (C4). When set, stored on the pending row for /confirm claim. */
  bindingInputSchemaHash?: string;
  /** From the bound tool (C4). For legacy Path A without binding, defaults to inputSchemaHash. */
  toolBindingHash?: string;
  confirmationProjection?: unknown;
  ttlMs: number;
  resumePayload: ChatToolResumePayloadV1;
}

export type BuildNormalizedPendingResult =
  | { ok: true; pending: ChatPendingActionV2; inputSchemaHash: string }
  // C3: invalid → NO pending, NO confirmation_required; caller emits ONE safe observation.
  | {
      ok: false;
      code:
        | 'chat.tool_unknown_capability'
        | 'chat.tool_arguments_invalid'
        | 'chat.resume_payload_invalid';
    };

/**
 * C3 normalize-before-confirm. Resolves the contract, validates rawInput with the
 * capability Zod input validator (applying defaults/coercions), and stores ONLY the
 * normalized value as pending.input. Confirm never re-reads input from the client.
 */
export function buildNormalizedPending(
  args: BuildNormalizedPendingArgs,
): BuildNormalizedPendingResult {
  const { ctx, capabilityName, rawInput } = args;

  // 1. Resolve contract via ctx.__runtime.resolveCapability (D4 pattern).
  const cap = ctx.__runtime?.resolveCapability?.(capabilityName);
  if (!cap) return { ok: false, code: 'chat.tool_unknown_capability' };

  // 2. Require parseable arguments; apply defaults/coercions.
  const parsed = cap.input.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: 'chat.tool_arguments_invalid' };
  const normalizedInput = parsed.data;

  // 3. Payload-bound hash (audit) and schema-only hash (claim / client echo).
  const described = ctx.capabilities.describe?.(capabilityName as RegisteredCapabilityName);
  const payloadSchemaHash = described
    ? capabilityActionHashV2(described.inputSchema, normalizedInput)
    : capabilityActionHashV2({}, normalizedInput);
  const inputSchemaHash = args.bindingInputSchemaHash ?? payloadSchemaHash;

  // 4. Enforce resume-payload size before allowing the proposal to be emitted.
  if (!resumePayloadWithinLimit(args.resumePayload)) {
    return { ok: false, code: 'chat.resume_payload_invalid' };
  }

  const now = Date.now();
  const pending: ChatPendingActionV2 = {
    version: 2,
    id: crypto.randomUUID(),
    sessionId: args.sessionId,
    expectedSessionRevision: args.expectedSessionRevision,
    capabilityName,
    input: normalizedInput,
    inputSchemaHash,
    toolBindingHash: args.toolBindingHash ?? inputSchemaHash,
    confirmationMessage: args.confirmationMessage,
    confirmationProjection: args.confirmationProjection,
    status: 'pending',
    expiresAt: new Date(now + args.ttlMs).toISOString(),
    resumePayload: args.resumePayload,
  };
  return { ok: true, pending, inputSchemaHash };
}
