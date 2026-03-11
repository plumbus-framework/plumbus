/**
 * Flow execution status values and valid transitions.
 * States: created → running → waiting → running → completed | failed | cancelled
 */

export const FlowStatus = {
  Created: "created",
  Running: "running",
  Waiting: "waiting",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export type FlowStatus = (typeof FlowStatus)[keyof typeof FlowStatus];

export const StepStatus = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Skipped: "skipped",
} as const;

export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export interface StepHistoryEntry {
  step: string;
  status: StepStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

/** Valid transitions from each flow status */
const validTransitions: Record<FlowStatus, FlowStatus[]> = {
  [FlowStatus.Created]: [FlowStatus.Running, FlowStatus.Cancelled],
  [FlowStatus.Running]: [
    FlowStatus.Waiting,
    FlowStatus.Completed,
    FlowStatus.Failed,
    FlowStatus.Cancelled,
  ],
  [FlowStatus.Waiting]: [FlowStatus.Running, FlowStatus.Cancelled, FlowStatus.Failed],
  [FlowStatus.Completed]: [],
  [FlowStatus.Failed]: [],
  [FlowStatus.Cancelled]: [],
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: FlowStatus, to: FlowStatus): boolean {
  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Assert a transition is valid, throwing if not.
 */
export function assertTransition(from: FlowStatus, to: FlowStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid flow status transition: "${from}" → "${to}"`,
    );
  }
}

/**
 * Check if a flow is in a terminal state (no further transitions possible).
 */
export function isTerminal(status: FlowStatus): boolean {
  return (
    status === FlowStatus.Completed ||
    status === FlowStatus.Failed ||
    status === FlowStatus.Cancelled
  );
}
