// ── Flow Simulator ──
// Simulate flow execution in-memory without requiring a database or queue.
// Walks through steps sequentially, tracking state and step history.

import { FlowStatus, StepStatus, type StepHistoryEntry } from '../flows/state-machine.js';
import {
  buildHistoryEntry,
  executeStep,
  type StepExecutorDeps,
  type StepResult,
} from '../flows/step-executor.js';
import type { ExecutionContext } from '../types/context.js';
import type { FlowDefinition, FlowStep } from '../types/flow.js';
import { createTestContext, type TestContextOptions } from './context.js';

// ── Simulation Result ──

export interface FlowSimulationResult {
  /** Final flow status */
  status: FlowStatus;
  /** Ordered history of step executions */
  history: StepHistoryEntry[];
  /** Final state after all steps */
  state: unknown;
  /** Step results indexed by step name */
  stepResults: Map<string, StepResult>;
  /** Error message if the flow failed */
  error?: string;
}

// ── Simulation Options ──

export interface SimulateFlowOptions extends TestContextOptions {
  /** Pre-built execution context */
  ctx?: ExecutionContext;
  /** Custom step executor deps (defaults: capabilities always succeed, conditions always true) */
  stepDeps?: Partial<StepExecutorDeps>;
  /** Maximum steps to execute (prevents infinite loops, default: 100) */
  maxSteps?: number;
  /** Override capability results by step name */
  capabilityResults?: Record<string, { success: boolean; data?: unknown; error?: unknown }>;
  /** Override condition evaluations by condition expression */
  conditionResults?: Record<string, boolean>;
}

/**
 * Simulate a flow execution in-memory, step by step.
 *
 * Usage:
 * ```ts
 * const result = await simulateFlow(myFlow, { orderId: "123" });
 * expect(result.status).toBe("completed");
 * expect(result.history).toHaveLength(3);
 * ```
 */
export async function simulateFlow(
  flow: FlowDefinition,
  input: unknown,
  options?: SimulateFlowOptions,
): Promise<FlowSimulationResult> {
  const ctx = options?.ctx ?? createTestContext(options);
  const maxSteps = options?.maxSteps ?? 100;

  // Build step deps with configurable results
  const stepDeps: StepExecutorDeps = {
    executeCapability:
      options?.stepDeps?.executeCapability ??
      (async (name) => {
        if (options?.capabilityResults?.[name]) {
          return options.capabilityResults[name]!;
        }
        return { success: true, data: {} };
      }),
    evaluateCondition:
      options?.stepDeps?.evaluateCondition ??
      ((expression) => {
        if (options?.conditionResults?.[expression] !== undefined) {
          return options.conditionResults[expression]!;
        }
        return true;
      }),
  };

  // Build step lookup
  const stepMap = new Map<string, FlowStep>();
  for (const step of flow.steps) {
    stepMap.set(step.name, step);
  }

  const history: StepHistoryEntry[] = [];
  const stepResults = new Map<string, StepResult>();
  const state = input;
  let executedCount = 0;

  // Start with the first step
  let currentStepIndex = 0;

  while (currentStepIndex < flow.steps.length && executedCount < maxSteps) {
    const step = flow.steps[currentStepIndex]!;
    executedCount++;

    const startedAt = ctx.time.now();
    const result = await executeStep(step, ctx, state, stepDeps);
    const completedAt = ctx.time.now();

    const entry = buildHistoryEntry(step.name, result, startedAt, completedAt);
    history.push(entry);
    stepResults.set(step.name, result);

    // Handle step failure
    if (result.status === StepStatus.Failed) {
      return {
        status: FlowStatus.Failed,
        history,
        state,
        stepResults,
        error: result.error,
      };
    }

    // Handle flow control
    if (result.waitEvent) {
      // Flow is waiting for an event — stop simulation
      return {
        status: FlowStatus.Waiting,
        history,
        state,
        stepResults,
      };
    }

    if (result.delayDuration) {
      // In simulation, skip delays and continue to next step
      currentStepIndex++;
      continue;
    }

    if (result.parallelBranches) {
      // Execute parallel branches sequentially in simulation
      for (const branchName of result.parallelBranches) {
        const branchStep = stepMap.get(branchName);
        if (branchStep) {
          executedCount++;
          const bStart = ctx.time.now();
          const bResult = await executeStep(branchStep, ctx, state, stepDeps);
          const bEnd = ctx.time.now();
          history.push(buildHistoryEntry(branchName, bResult, bStart, bEnd));
          stepResults.set(branchName, bResult);

          if (bResult.status === StepStatus.Failed) {
            return {
              status: FlowStatus.Failed,
              history,
              state,
              stepResults,
              error: bResult.error,
            };
          }
        }
      }
      currentStepIndex++;
      continue;
    }

    if (result.nextStep) {
      // Conditional branch — jump to the named step
      const nextIndex = flow.steps.findIndex((s) => s.name === result.nextStep);
      if (nextIndex >= 0) {
        currentStepIndex = nextIndex;
        continue;
      }
      // Named step not found — treat as completion of conditional
      currentStepIndex++;
      continue;
    }

    // Normal completion — advance to next step
    currentStepIndex++;
  }

  if (executedCount >= maxSteps) {
    return {
      status: FlowStatus.Failed,
      history,
      state,
      stepResults,
      error: `Exceeded maximum step limit (${maxSteps})`,
    };
  }

  return {
    status: FlowStatus.Completed,
    history,
    state,
    stepResults,
  };
}
