import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import type { EventQueue } from '../events/queue.js';
import type { AuditService } from '../types/audit.js';
import type { ExecutionContext, FlowExecution } from '../types/context.js';
import { BackoffStrategy } from '../types/enums.js';
import type { FlowDefinition, FlowStep } from '../types/flow.js';
import type { AuthContext } from '../types/security.js';
import type { FlowRegistry } from './registry.js';
import { flowExecutionsTable } from './schema.js';
import {
  FlowStatus,
  StepStatus,
  assertTransition,
  isTerminal,
  type StepHistoryEntry,
} from './state-machine.js';
import { buildHistoryEntry, executeStep, type StepExecutorDeps } from './step-executor.js';

export interface FlowEngineConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  stepDeps: StepExecutorDeps;
  audit?: AuditService;
  queue?: EventQueue;
}

interface FlowExecutionRow {
  id: string;
  flowName: string;
  domain: string;
  status: string;
  input: unknown;
  state: unknown;
  currentStep: string | null;
  stepHistory: unknown;
  retryCount: number;
  lastError: string | null;
  actor: string;
  tenantId: string | null;
  correlationId: string | null;
  triggerEventId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** Type-safe partial update payload for flow executions. */
interface FlowExecutionUpdate {
  status?: string;
  input?: unknown;
  state?: unknown;
  currentStep?: string | null;
  stepHistory?: StepHistoryEntry[];
  retryCount?: number;
  lastError?: string | null;
  completedAt?: Date | null;
}

/**
 * Creates the flow execution engine that manages flow lifecycle:
 * start, run steps, handle wait/resume, and persist state.
 */
export function createFlowEngine(config: FlowEngineConfig) {
  const { db, registry, stepDeps, audit } = config;

  /**
   * Start a new flow execution.
   */
  async function start(
    flowName: string,
    input: unknown,
    auth: AuthContext,
    opts?: { correlationId?: string; triggerEventId?: string },
  ): Promise<FlowExecution> {
    const flow = registry.get(flowName);
    if (!flow) {
      throw new Error(`Flow "${flowName}" is not registered`);
    }

    // Validate input
    const parseResult = flow.input.safeParse(input);
    if (!parseResult.success) {
      throw new Error(`Flow "${flowName}": invalid input — ${parseResult.error.message}`);
    }

    const executionId = randomUUID();
    const initialState = flow.state ? {} : null;

    await db.insert(flowExecutionsTable).values({
      id: executionId,
      flowName,
      domain: flow.domain,
      status: FlowStatus.Created,
      input: parseResult.data as Record<string, unknown>,
      state: initialState as Record<string, unknown> | null,
      currentStep: flow.steps[0]?.name ?? null,
      stepHistory: [],
      actor: auth.userId ?? 'system',
      tenantId: auth.tenantId ?? null,
      correlationId: opts?.correlationId ?? null,
      triggerEventId: opts?.triggerEventId ?? null,
    });

    if (audit) {
      await audit.record(`flow.started.${flowName}`, {
        executionId,
        flowName,
        actor: auth.userId,
        tenantId: auth.tenantId,
        outcome: 'success',
      });
    }

    return {
      id: executionId,
      flowName,
      status: FlowStatus.Created,
    };
  }

  /**
   * Run the next step(s) for a flow execution.
   * This is designed to be called by a worker process.
   */
  async function runNext(executionId: string, ctx: ExecutionContext): Promise<FlowExecution> {
    const rows = await db
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) {
      throw new Error(`Flow execution "${executionId}" not found`);
    }

    if (isTerminal(row.status as FlowStatus)) {
      return { id: row.id, flowName: row.flowName, status: row.status };
    }

    const flow = registry.get(row.flowName);
    if (!flow) {
      throw new Error(`Flow "${row.flowName}" is not registered`);
    }

    // Transition to running
    if (row.status === FlowStatus.Created || row.status === FlowStatus.Waiting) {
      assertTransition(row.status as FlowStatus, FlowStatus.Running);
      await updateExecution(executionId, { status: FlowStatus.Running });
    }

    // Find current step
    const currentStepName = row.currentStep;
    if (!currentStepName) {
      // No more steps — complete the flow
      await completeFlow(executionId, row.flowName);
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
    }

    const step = flow.steps.find((s) => s.name === currentStepName);
    if (!step) {
      await failFlow(
        executionId,
        row.flowName,
        `Step "${currentStepName}" not found in flow definition`,
      );
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
    }

    // Build flow-scoped context
    const flowCtx: ExecutionContext = {
      ...ctx,
      state: row.state,
      step: currentStepName,
      flowId: executionId,
    };

    // Execute the step
    const startedAt = new Date();
    const result = await executeStep(step, flowCtx, row.state, stepDeps);
    const completedAt = new Date();

    const historyEntry = buildHistoryEntry(currentStepName, result, startedAt, completedAt);
    const history = Array.isArray(row.stepHistory) ? (row.stepHistory as StepHistoryEntry[]) : [];
    history.push(historyEntry);

    if (audit) {
      await audit.record(`flow.step.${result.status}.${currentStepName}`, {
        executionId,
        flowName: row.flowName,
        step: currentStepName,
        status: result.status,
        error: result.error,
      });
    }

    // Handle result
    if (result.status === StepStatus.Failed) {
      return handleStepFailure(executionId, row, flow, history, result.error);
    }

    // Wait step — pause the flow
    if (result.waitEvent) {
      await updateExecution(executionId, {
        status: FlowStatus.Waiting,
        stepHistory: history,
        currentStep: currentStepName, // stay on current step until resumed
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Delay step — schedule next step after duration
    if (result.delayDuration) {
      const nextStep = getNextStepName(flow.steps, currentStepName);
      await updateExecution(executionId, {
        status: FlowStatus.Waiting,
        stepHistory: history,
        currentStep: nextStep,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Parallel step — execute all branches concurrently, then advance
    if (result.parallelBranches) {
      const branchSteps = result.parallelBranches
        .map((branchName) => flow.steps.find((s) => s.name === branchName))
        .filter((s): s is FlowStep => s != null);

      const branchResults = await Promise.allSettled(
        branchSteps.map(async (branchStep) => {
          const startedAtBranch = new Date();
          const branchResult = await executeStep(branchStep, flowCtx, row.state, stepDeps);
          const completedAtBranch = new Date();
          const branchEntry = buildHistoryEntry(
            branchStep.name,
            branchResult,
            startedAtBranch,
            completedAtBranch,
          );
          return { result: branchResult, entry: branchEntry };
        }),
      );

      // Merge all branch history entries after all branches have settled
      for (const settled of branchResults) {
        if (settled.status === 'fulfilled') {
          history.push(settled.value.entry);
        }
      }

      const anyFailed = branchResults.some(
        (r) =>
          r.status === 'rejected' ||
          (r.status === 'fulfilled' && r.value.result.status === StepStatus.Failed),
      );

      if (anyFailed) {
        return handleStepFailure(
          executionId,
          row,
          flow,
          history,
          'One or more parallel branches failed',
        );
      }

      const nextStep = getNextStepName(flow.steps, currentStepName);
      await updateExecution(executionId, {
        stepHistory: history,
        currentStep: nextStep,
      });
      if (!nextStep) {
        await completeFlow(executionId, row.flowName);
        return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
      }
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Conditional step — jump to the chosen branch
    if (result.nextStep) {
      await updateExecution(executionId, {
        stepHistory: history,
        currentStep: result.nextStep,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Normal completion — advance to next step
    const nextStep = getNextStepName(flow.steps, currentStepName);
    if (!nextStep) {
      await updateExecution(executionId, { stepHistory: history });
      await completeFlow(executionId, row.flowName);
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
    }

    await updateExecution(executionId, {
      stepHistory: history,
      currentStep: nextStep,
    });
    return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
  }

  /**
   * Resume a waiting flow (e.g., after an event arrives or approval granted).
   */
  async function resume(executionId: string, signal?: unknown): Promise<void> {
    const rows = await db
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (row.status !== FlowStatus.Waiting) {
      throw new Error(`Cannot resume flow "${executionId}" — current status is "${row.status}"`);
    }

    const flow = registry.get(row.flowName);
    if (!flow) throw new Error(`Flow "${row.flowName}" not registered`);

    // Advance past the wait/delay step
    const nextStep = getNextStepName(flow.steps, row.currentStep ?? '');

    await updateExecution(executionId, {
      status: FlowStatus.Running,
      currentStep: nextStep,
      state: signal !== undefined ? signal : row.state,
    });
  }

  /**
   * Cancel a running or waiting flow.
   */
  async function cancel(executionId: string): Promise<void> {
    const rows = await db
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (isTerminal(row.status as FlowStatus)) {
      throw new Error(
        `Cannot cancel flow "${executionId}" — already in terminal state "${row.status}"`,
      );
    }

    assertTransition(row.status as FlowStatus, FlowStatus.Cancelled);
    await updateExecution(executionId, {
      status: FlowStatus.Cancelled,
      completedAt: new Date(),
    });

    if (audit) {
      await audit.record(`flow.cancelled.${row.flowName}`, {
        executionId,
        flowName: row.flowName,
      });
    }
  }

  /**
   * Get the current status of a flow execution.
   */
  async function status(executionId: string): Promise<FlowExecution> {
    const rows = await db
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    return { id: row.id, flowName: row.flowName, status: row.status };
  }

  // ── Internal helpers ──

  async function handleStepFailure(
    executionId: string,
    row: FlowExecutionRow,
    flow: FlowDefinition,
    history: StepHistoryEntry[],
    error?: string,
  ): Promise<FlowExecution> {
    const retryCount = row.retryCount + 1;
    const maxRetries = flow.retry?.attempts ?? 0;

    if (retryCount <= maxRetries) {
      // Retry: keep current step, increment counter
      await updateExecution(executionId, {
        stepHistory: history,
        retryCount,
        lastError: error ?? null,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Exhausted retries — fail the flow
    await failFlow(executionId, row.flowName, error);
    return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
  }

  async function completeFlow(executionId: string, flowName: string): Promise<void> {
    await updateExecution(executionId, {
      status: FlowStatus.Completed,
      currentStep: null,
      completedAt: new Date(),
    });
    if (audit) {
      await audit.record(`flow.completed.${flowName}`, { executionId, flowName });
    }
  }

  async function failFlow(executionId: string, flowName: string, error?: string): Promise<void> {
    await updateExecution(executionId, {
      status: FlowStatus.Failed,
      lastError: error ?? 'Unknown error',
      completedAt: new Date(),
    });
    if (audit) {
      await audit.record(`flow.failed.${flowName}`, {
        executionId,
        flowName,
        error,
      });
    }
  }

  async function updateExecution(id: string, updates: FlowExecutionUpdate): Promise<void> {
    await db
      .update(flowExecutionsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(flowExecutionsTable.id, id));
  }

  return { start, runNext, resume, cancel, status };
}

/**
 * Get the next step name in a linear flow sequence.
 * Returns undefined if we're at the last step.
 */
function getNextStepName(steps: FlowStep[], currentStepName: string): string | undefined {
  const idx = steps.findIndex((s) => s.name === currentStepName);
  if (idx === -1 || idx >= steps.length - 1) return undefined;
  return steps[idx + 1]?.name;
}

/**
 * Compute a retry delay in milliseconds given the retry policy.
 */
export function computeRetryDelay(retryCount: number, backoff: string, baseDelayMs = 1000): number {
  if (backoff === BackoffStrategy.Exponential) {
    return baseDelayMs * 2 ** (retryCount - 1);
  }
  return baseDelayMs; // fixed
}
