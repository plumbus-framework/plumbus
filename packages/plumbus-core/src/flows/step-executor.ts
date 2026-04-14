import type { ExecutionContext } from '../types/context.js';
import { FlowStepType } from '../types/enums.js';
import type {
  CapabilityStep,
  ConditionalStep,
  DelayStep,
  EventEmitStep,
  FlowStep,
  ParallelStep,
  WaitStep,
} from '../types/flow.js';
import { type StepHistoryEntry, StepStatus } from './state-machine.js';

export interface StepResult {
  status: StepStatus;
  /** Successful capability output that should be merged into flow state */
  data?: unknown;
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
 *
 * @param flowInput — the original flow trigger input (immutable after start)
 * @param state     — the mutable flow state accumulated across steps
 */
export async function executeStep(
  step: FlowStep,
  ctx: ExecutionContext,
  flowInput: unknown,
  state: unknown,
  deps: StepExecutorDeps,
): Promise<StepResult> {
  switch (step.type) {
    case FlowStepType.Capability:
      return executeCapabilityStep(step, ctx, flowInput, state, deps);
    case FlowStepType.Conditional:
      return executeConditionalStep(step, state, deps);
    case FlowStepType.Wait:
      return executeWaitStep(step);
    case FlowStepType.Delay:
      return executeDelayStep(step);
    case FlowStepType.Parallel:
      return executeParallelStep(step);
    case FlowStepType.EventEmit:
      return executeEventEmitStep(step, ctx, flowInput, state);
    default:
      return {
        status: StepStatus.Failed,
        error: `Unknown step type: ${(step as FlowStep).type}`,
      };
  }
}

/**
 * Resolve a step's input by merging flow input, state, and step-level overrides.
 *
 * Step input values can reference flow input or state via template strings:
 *   `$input.fieldName` — resolves to the corresponding field from flowInput
 *   `$state.fieldName` — resolves to the corresponding field from state
 *   any other value     — used as-is (literal)
 */
function resolveStepPayload(
  stepInput: Record<string, unknown> | undefined,
  flowInput: unknown,
  state: unknown,
): Record<string, unknown> {
  const inputObj = (flowInput && typeof flowInput === 'object' ? flowInput : {}) as Record<
    string,
    unknown
  >;
  const stateObj = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;

  // Base: flow input merged with state (state fields override input fields)
  const merged: Record<string, unknown> = { ...inputObj, ...stateObj };

  if (!stepInput) return merged;

  // Apply step-level overrides with template resolution
  for (const [key, value] of Object.entries(stepInput)) {
    if (typeof value === 'string' && value.startsWith('$input.')) {
      merged[key] = inputObj[value.slice(7)];
    } else if (typeof value === 'string' && value.startsWith('$state.')) {
      merged[key] = stateObj[value.slice(7)];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

async function executeCapabilityStep(
  step: CapabilityStep,
  ctx: ExecutionContext,
  flowInput: unknown,
  state: unknown,
  deps: StepExecutorDeps,
): Promise<StepResult> {
  try {
    const capInput = resolveStepPayload(step.input, flowInput, state);
    const capabilityName = step.capability ?? step.name;
    const result = await deps.executeCapability(capabilityName, ctx, capInput);
    if (result.success) {
      return { status: StepStatus.Completed, data: result.data };
    }
    return {
      status: StepStatus.Failed,
      error:
        typeof result.error === 'object' && result.error !== null
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
  flowInput: unknown,
  state: unknown,
): Promise<StepResult> {
  try {
    await ctx.events.emit(step.event, resolveStepPayload(undefined, flowInput, state));
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
