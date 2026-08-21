/**
 * Flow wait event for an in-flight approval.
 *
 * Uses the existing Wait step (`FlowStepType.Wait`) — not a second engine.
 * `createFlowEngine` already pauses on `waitEvent` and `resume`s after an event.
 */
export const APPROVAL_PENDING_WAIT = 'approval_pending' as const;

export type ApprovalPendingWait = typeof APPROVAL_PENDING_WAIT;

export function isApprovalPendingWait(event: string): event is ApprovalPendingWait {
  return event === APPROVAL_PENDING_WAIT;
}
