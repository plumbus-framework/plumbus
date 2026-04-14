import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import type { EventQueue } from '../events/queue.js';
import type { AuditService } from '../types/audit.js';
import type {
  DataService,
  EventService,
  ExecutionContext,
  FlowExecution,
} from '../types/context.js';
import { BackoffStrategy } from '../types/enums.js';
import type { FlowDefinition, FlowStep, ParallelStep } from '../types/flow.js';
import type { AuthContext } from '../types/security.js';
import type { FlowRegistry } from './registry.js';
import { flowExecutionsTable } from './schema.js';
import {
  assertTransition,
  FlowStatus,
  isTerminal,
  type StepHistoryEntry,
  StepStatus,
} from './state-machine.js';
import { buildHistoryEntry, executeStep, type StepExecutorDeps } from './step-executor.js';

export interface FlowEngineConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  stepDeps: StepExecutorDeps;
  audit?: AuditService;
  queue?: EventQueue;
  /** Create a data service scoped to a specific auth context (for tenant isolation in flows). */
  createDataService?: (auth: AuthContext) => DataService;
  /** Create an event service scoped to a specific auth context. */
  createEventService?: (auth: AuthContext) => EventService;
  /** Called when a flow fails permanently (after retries exhausted). */
  onFlowError?: (info: {
    executionId: string;
    flowName: string;
    step: string | null;
    error: string;
    tenantId?: string | null;
    actor?: string;
    db?: PostgresJsDatabase;
  }) => Promise<void> | void;
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
  waitingForEvent: string | null;
  wakeAt: Date | null;
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
  waitingForEvent?: string | null;
  wakeAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * Creates the flow execution engine that manages flow lifecycle:
 * start, run steps, handle wait/resume, and persist state.
 */
export function createFlowEngine(config: FlowEngineConfig) {
  const { db, registry, stepDeps, audit, onFlowError, createEventService } = config;

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
    const initialState = flow.state
      ? (() => {
          const parsed = flow.state.safeParse({});
          return parsed.success ? parsed.data : {};
        })()
      : null;

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
    } satisfies typeof flowExecutionsTable.$inferInsert);

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

    // Do not auto-run event waits, and do not run delayed waits until due.
    if (row.status === FlowStatus.Waiting && row.waitingForEvent) {
      return { id: row.id, flowName: row.flowName, status: FlowStatus.Waiting };
    }
    if (row.status === FlowStatus.Waiting && row.wakeAt && row.wakeAt.getTime() > Date.now()) {
      return { id: row.id, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Transition to running
    if (row.status === FlowStatus.Created || row.status === FlowStatus.Waiting) {
      assertTransition(row.status as FlowStatus, FlowStatus.Running);
      await updateExecution(executionId, {
        status: FlowStatus.Running,
        waitingForEvent: null,
        wakeAt: null,
      });
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
        row,
      );
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
    }

    // Build flow-scoped context with tenant-aware auth from stored execution
    const flowAuth: AuthContext = {
      ...ctx.auth,
      tenantId: row.tenantId ?? ctx.auth.tenantId,
      userId: row.actor ?? ctx.auth.userId,
      internal: true,
    };
    const flowData = config.createDataService ? config.createDataService(flowAuth) : ctx.data;
    const flowEvents = createEventService ? createEventService(flowAuth) : ctx.events;
    const flowCtx: ExecutionContext = {
      ...ctx,
      auth: flowAuth,
      data: flowData,
      events: flowEvents,
      state: row.state,
      step: currentStepName,
      flowId: executionId,
    };

    // Execute the step
    const startedAt = new Date();
    const result = await executeStep(step, flowCtx, row.input, row.state, stepDeps);
    const completedAt = new Date();

    const historyEntry = buildHistoryEntry(currentStepName, result, startedAt, completedAt);
    const history = Array.isArray(row.stepHistory) ? (row.stepHistory as StepHistoryEntry[]) : [];
    history.push(historyEntry);
    const nextState = mergeExecutionState(row.state, result.data);

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
        state: nextState,
        stepHistory: history,
        currentStep: currentStepName, // stay on current step until resumed
        waitingForEvent: result.waitEvent,
        wakeAt: null,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Delay step — schedule next step after duration
    if (result.delayDuration) {
      const nextStep = getNextStepName(flow.steps, currentStepName);
      let delayMs: number;
      try {
        delayMs = parseDurationToMs(result.delayDuration);
      } catch (err) {
        return handleStepFailure(
          executionId,
          row,
          flow,
          history,
          err instanceof Error ? err.message : String(err),
        );
      }
      await updateExecution(executionId, {
        status: FlowStatus.Waiting,
        state: nextState,
        stepHistory: history,
        currentStep: nextStep,
        waitingForEvent: null,
        wakeAt: new Date(Date.now() + delayMs),
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Parallel step — execute all branches concurrently, then advance
    if (result.parallelBranches) {
      let parallelState = nextState;
      const branchSteps = result.parallelBranches
        .map((branchName) => flow.steps.find((s) => s.name === branchName))
        .filter((s): s is FlowStep => s != null);

      const branchResults = await Promise.allSettled(
        branchSteps.map(async (branchStep) => {
          const branchStart = new Date();
          const branchResult = await executeStep(
            branchStep,
            flowCtx,
            row.input,
            row.state,
            stepDeps,
          );
          const branchEnd = new Date();
          return { branchStep, branchResult, branchStart, branchEnd };
        }),
      );

      // Merge branch history entries after all branches complete (avoids concurrent mutation)
      for (const settled of branchResults) {
        if (settled.status === 'fulfilled') {
          const { branchStep, branchResult, branchStart, branchEnd } = settled.value;
          history.push(buildHistoryEntry(branchStep.name, branchResult, branchStart, branchEnd));
          parallelState = mergeExecutionState(parallelState, branchResult.data);
        }
      }

      const anyFailed = branchResults.some(
        (r) =>
          r.status === 'rejected' ||
          (r.status === 'fulfilled' && r.value.branchResult.status === StepStatus.Failed),
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
        state: parallelState,
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
        state: nextState,
        stepHistory: history,
        currentStep: result.nextStep,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Normal completion — advance to next step
    const nextStep = getNextStepName(flow.steps, currentStepName);
    if (!nextStep) {
      await updateExecution(executionId, { state: nextState, stepHistory: history });
      await completeFlow(executionId, row.flowName);
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
    }

    await updateExecution(executionId, {
      state: nextState,
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
      waitingForEvent: null,
      wakeAt: null,
    });
  }

  /**
   * Resume all flows waiting on a specific event type.
   * Returns the number of executions resumed.
   */
  async function resumeWaitingByEvent(eventType: string, signal?: unknown): Promise<number> {
    const rows = await db
      .select({ id: flowExecutionsTable.id })
      .from(flowExecutionsTable)
      .where(
        and(
          eq(flowExecutionsTable.status, FlowStatus.Waiting),
          eq(flowExecutionsTable.waitingForEvent, eventType),
        ),
      );

    for (const row of rows) {
      await resume(row.id, signal);
    }
    return rows.length;
  }

  /**
   * Returns execution IDs that should be processed now.
   */
  async function listRunnable(limit = 50): Promise<string[]> {
    const now = new Date();
    const rows = await db
      .select({ id: flowExecutionsTable.id })
      .from(flowExecutionsTable)
      .where(
        or(
          inArray(flowExecutionsTable.status, [FlowStatus.Created, FlowStatus.Running]),
          and(
            eq(flowExecutionsTable.status, FlowStatus.Waiting),
            isNull(flowExecutionsTable.waitingForEvent),
            lte(flowExecutionsTable.wakeAt, now),
          ),
        ),
      )
      .limit(limit);

    return rows.map((row) => row.id);
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
    await failFlow(executionId, row.flowName, error, row);
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

  async function failFlow(
    executionId: string,
    flowName: string,
    error?: string,
    row?: FlowExecutionRow,
  ): Promise<void> {
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
    if (onFlowError) {
      try {
        await onFlowError({
          executionId,
          flowName,
          step: row?.currentStep ?? null,
          error: error ?? 'Unknown error',
          tenantId: row?.tenantId,
          actor: row?.actor,
          db,
        });
      } catch {
        // Swallow — error logging must never break flow processing
      }
    }
  }

  async function updateExecution(id: string, updates: FlowExecutionUpdate): Promise<void> {
    await db
      .update(flowExecutionsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(flowExecutionsTable.id, id));
  }

  return { start, runNext, resume, resumeWaitingByEvent, listRunnable, cancel, status };
}

function mergeExecutionState(currentState: unknown, stepData: unknown): unknown {
  if (stepData === undefined) {
    return currentState;
  }

  if (
    currentState &&
    typeof currentState === 'object' &&
    !Array.isArray(currentState) &&
    stepData &&
    typeof stepData === 'object' &&
    !Array.isArray(stepData)
  ) {
    return {
      ...(currentState as Record<string, unknown>),
      ...(stepData as Record<string, unknown>),
    };
  }

  return stepData;
}

/**
 * Collect all step names that are branches of parallel steps.
 * These should be skipped during linear step advancement.
 */
function collectBranchNames(steps: FlowStep[]): Set<string> {
  const branches = new Set<string>();
  for (const step of steps) {
    if (step.type === 'parallel' && 'branches' in step) {
      for (const b of (step as ParallelStep).branches) branches.add(b);
    }
  }
  return branches;
}

/**
 * Get the next step name in a linear flow sequence.
 * Returns undefined if we're at the last step.
 * Skips branch steps that belong to parallel steps.
 */
function getNextStepName(steps: FlowStep[], currentStepName: string): string | undefined {
  const branchNames = collectBranchNames(steps);
  let idx = steps.findIndex((s) => s.name === currentStepName);
  if (idx === -1 || idx >= steps.length - 1) return undefined;
  idx++;
  while (idx < steps.length && branchNames.has(steps[idx]?.name ?? '')) {
    idx++;
  }
  if (idx >= steps.length) return undefined;
  return steps[idx]?.name;
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

function parseDurationToMs(duration: string): number {
  const trimmed = duration.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid delay duration "${duration}". Expected formats like "30s", "5m", "1h".`,
    );
  }

  const [, valueRaw, unit] = match;
  if (!valueRaw || !unit) {
    throw new Error(`Invalid delay duration "${duration}".`);
  }
  const value = parseInt(valueRaw, 10);

  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 3_600_000;
  return value * 86_400_000;
}
