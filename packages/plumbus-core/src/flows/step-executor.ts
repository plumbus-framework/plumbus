import type { ExecutionContext } from "../types/context.js";
import { FlowStepType } from "../types/enums.js";
import type {
    CapabilityStep,
    ConditionalStep,
    DelayStep,
    EventEmitStep,
    FlowStep,
    ParallelStep,
    WaitStep,
} from "../types/flow.js";
import { StepStatus, type StepHistoryEntry } from "./state-machine.js";

export interface StepResult {
  status: StepStatus;
  /** For condition steps: the chosen branch step name */
  nextStep?: string;
  /** For wait steps: the event we're waiting for */
  waitEvent?: string;
  /** For delay steps: the delay duration string */
  delayDuration?: string;
  /** For parallel steps: the branch names to execute concurrently */
  parallelBranches?: string[];
  /** Error message if the step failed */
  error?: string;
}

export interface StepExecutorDeps {
  /** Execute a named capability and return its output */
  executeCapability: (
    capabilityName: string,
    ctx: ExecutionContext,
    input: unknown,
  ) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  /** Evaluate a condition expression against the flow state */
  evaluateCondition: (expression: string, state: unknown) => boolean;
}

/**
 * Execute a single flow step. Returns a StepResult describing what happened
 * and what should happen next (next step, wait, delay, parallel branches).
 */
export async function executeStep(
  step: FlowStep,
  ctx: ExecutionContext,
  state: unknown,
  deps: StepExecutorDeps,
): Promise<StepResult> {
  switch (step.type) {
    case FlowStepType.Capability:
      return executeCapabilityStep(step, ctx, state, deps);
    case FlowStepType.Conditional:
      return executeConditionalStep(step, state, deps);
    case FlowStepType.Wait:
      return executeWaitStep(step);
    case FlowStepType.Delay:
      return executeDelayStep(step);
    case FlowStepType.Parallel:
      return executeParallelStep(step);
    case FlowStepType.EventEmit:
      return executeEventEmitStep(step, ctx, state);
    default:
      return {
        status: StepStatus.Failed,
        error: `Unknown step type: ${(step as FlowStep).type}`,
      };
  }
}

async function executeCapabilityStep(
  step: CapabilityStep,
  ctx: ExecutionContext,
  state: unknown,
  deps: StepExecutorDeps,
): Promise<StepResult> {
  try {
    const result = await deps.executeCapability(step.name, ctx, state);
    if (result.success) {
      return { status: StepStatus.Completed };
    }
    return {
      status: StepStatus.Failed,
      error: typeof result.error === "object" && result.error !== null
        ? JSON.stringify(result.error)
        : String(result.error),
    };
  } catch (err) {
    return {
      status: StepStatus.Failed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function executeConditionalStep(
  step: ConditionalStep,
  state: unknown,
  deps: StepExecutorDeps,
): Promise<StepResult> {
  try {
    const conditionMet = deps.evaluateCondition(step.if, state);
    return Promise.resolve({
      status: StepStatus.Completed,
      nextStep: conditionMet ? step.then : step.else,
    });
  } catch (err) {
    return Promise.resolve({
      status: StepStatus.Failed,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function executeWaitStep(step: WaitStep): Promise<StepResult> {
  // Wait steps pause the flow — the engine will set status to "waiting"
  // and resume when the specified event arrives.
  return Promise.resolve({
    status: StepStatus.Completed,
    waitEvent: step.event,
  });
}

function executeDelayStep(step: DelayStep): Promise<StepResult> {
  // Delay steps schedule the next step after a duration.
  return Promise.resolve({
    status: StepStatus.Completed,
    delayDuration: step.duration,
  });
}

function executeParallelStep(step: ParallelStep): Promise<StepResult> {
  // Parallel steps enqueue multiple branches concurrently.
  return Promise.resolve({
    status: StepStatus.Completed,
    parallelBranches: step.branches,
  });
}

async function executeEventEmitStep(
  step: EventEmitStep,
  ctx: ExecutionContext,
  state: unknown,
): Promise<StepResult> {
  try {
    await ctx.events.emit(step.event, state);
    return { status: StepStatus.Completed };
  } catch (err) {
    return {
      status: StepStatus.Failed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build a StepHistoryEntry for audit/persistence.
 */
export function buildHistoryEntry(
  stepName: string,
  result: StepResult,
  startedAt: Date,
  completedAt: Date,
): StepHistoryEntry {
  return {
    step: stepName,
    status: result.status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    error: result.error,
  };
}
