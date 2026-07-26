import type { ExecutionContext } from '@plumbus/core';
import type { ChatEvent } from '../types/event.js';
import type { ToolExecutionRecord } from '../types/tool.js';

/**
 * Flow tools are ALWAYS auto (never confirm). This module starts a flow via
 * `ctx.flows.start(...)` then polls `ctx.flows.status(...)` until the flow
 * reaches a terminal status, the per-call await budget elapses, or the turn is
 * aborted. It NEVER reports 'completed' for a non-terminal flow — a still-running
 * flow is reported as 'in_progress'.
 *
 * Asymmetry (documented in docs/chat/policies.md): a capability bound as a tool
 * that carries write effects is bound in CONFIRM mode, whereas a flow listed in
 * `policy.toolCalling.autoStartFlows` is bound in AUTO mode and starts without a
 * confirmation step.
 */

const TERMINAL_FLOW_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export type ExecuteFlowToolStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'in_progress'
  | 'indeterminate';

export interface ExecuteFlowToolParams {
  ctx: ExecutionContext;
  flowName: string;
  /** Normalized flow input; validated by the flow engine on `start`. */
  input: unknown;
  /** Total ms this call may spend polling for a terminal status. `<= 0` disables polling. */
  awaitMs: number;
  /** Poll cadence in ms (clamped to `>= 1`). */
  pollIntervalMs: number;
  /** Aborts the poll loop when the turn is aborted. */
  signal?: AbortSignal;
}

export interface ExecuteFlowToolResult {
  executionId: string;
  status: ExecuteFlowToolStatus;
  /** Raw flow status string last observed, when known. */
  flowStatus?: string;
  /** True when the await window elapsed while the flow was still non-terminal. */
  awaitBudgetElapsed: boolean;
  /** Milliseconds actually spent polling — added to the per-turn await counter by the caller. */
  awaitMsUsed: number;
}

export interface FlowToolTurnBudget {
  /** From `policy.toolCalling.maxFlowStartsPerTurn` (A.4 default 2). */
  maxFlowStartsPerTurn: number;
  /** From `policy.toolCalling.flowAwaitBudgetMsPerTurn` (A.4 default 15_000; `0` disables polling). */
  flowAwaitBudgetMsPerTurn: number;
  /** From `policy.toolCalling.flowAwaitMs` (A.4 default 10_000). */
  flowAwaitMs: number;
  /** From `policy.toolCalling.flowPollIntervalMs` (A.4 default 250). */
  flowPollIntervalMs: number;
}

export interface FlowToolTurnCounters {
  flowStartsUsed: number;
  flowAwaitMsUsed: number;
}

export interface RunFlowToolCallParams {
  ctx: ExecutionContext;
  toolCallId: string;
  /** Bound flow tool from bind-tools.ts (kind === 'flow'). */
  bound: { kind: 'flow'; targetName: string; tool: { name: string } };
  /** Normalized flow input (provider `argumentsStatus === 'parsed'` value). */
  input: unknown;
  budget: FlowToolTurnBudget;
  counters: FlowToolTurnCounters;
  signal?: AbortSignal;
}

export interface RunFlowToolCallResult {
  record: ToolExecutionRecord;
  /** JSON string observation fed back to the model as the tool message. */
  observation: string;
  /** tool.completed / tool.failed event for the caller to emit. */
  toolEvent: Extract<ChatEvent, { type: 'tool.completed' | 'tool.failed' }>;
  /** Cumulative counters AFTER this call (never resets any budget). */
  counters: FlowToolTurnCounters;
  /** True when the per-turn await budget elapsed while the flow was still running. */
  awaitBudgetElapsed: boolean;
}

function mapFlowStatus(flowStatus: string): ExecuteFlowToolStatus {
  if (flowStatus === 'completed') return 'completed';
  if (flowStatus === 'failed') return 'failed';
  if (flowStatus === 'cancelled') return 'cancelled';
  return 'in_progress';
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve('aborted');
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('elapsed');
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Start a flow and poll to terminal | budget-exhaustion | abort.
 * Assumes the flow is registered (the bind step already resolved it); a throw
 * from `start` therefore signals invalid arguments and is propagated to the caller.
 */
export async function executeFlowTool(
  params: ExecuteFlowToolParams,
): Promise<ExecuteFlowToolResult> {
  const { ctx, flowName, input, awaitMs, pollIntervalMs, signal } = params;
  const started = await ctx.flows.start(flowName, input);
  const executionId = started.id;
  let lastFlowStatus = started.status;

  // No polling window, or already terminal on start.
  if (awaitMs <= 0 || TERMINAL_FLOW_STATUSES.has(lastFlowStatus)) {
    return {
      executionId,
      status: mapFlowStatus(lastFlowStatus),
      flowStatus: lastFlowStatus,
      awaitBudgetElapsed: awaitMs <= 0 && !TERMINAL_FLOW_STATUSES.has(lastFlowStatus),
      awaitMsUsed: 0,
    };
  }

  const pollStart = Date.now();
  const deadline = pollStart + awaitMs;
  const interval = Math.max(1, pollIntervalMs);

  while (!signal?.aborted && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await abortableDelay(Math.min(interval, remaining), signal);
    if (outcome === 'aborted') break;

    let current: { id: string; flowName: string; status: string };
    try {
      current = await ctx.flows.status(executionId);
    } catch {
      return {
        executionId,
        status: 'indeterminate',
        flowStatus: undefined,
        awaitBudgetElapsed: false,
        awaitMsUsed: Date.now() - pollStart,
      };
    }
    lastFlowStatus = current.status;
    if (TERMINAL_FLOW_STATUSES.has(lastFlowStatus)) {
      return {
        executionId,
        status: mapFlowStatus(lastFlowStatus),
        flowStatus: lastFlowStatus,
        awaitBudgetElapsed: false,
        awaitMsUsed: Date.now() - pollStart,
      };
    }
  }

  return {
    executionId,
    status: mapFlowStatus(lastFlowStatus), // non-terminal → 'in_progress'
    flowStatus: lastFlowStatus,
    awaitBudgetElapsed: !signal?.aborted && Date.now() >= deadline,
    awaitMsUsed: Date.now() - pollStart,
  };
}

function buildResult(
  counters: FlowToolTurnCounters,
  record: ToolExecutionRecord,
  observation: unknown,
  toolEvent: Extract<ChatEvent, { type: 'tool.completed' | 'tool.failed' }>,
  awaitBudgetElapsed = false,
): RunFlowToolCallResult {
  return {
    counters,
    record,
    observation: JSON.stringify(observation),
    toolEvent,
    awaitBudgetElapsed,
  };
}

/**
 * Budget-aware dispatch for a single flow tool call. Enforces
 * `maxFlowStartsPerTurn` and the cumulative `flowAwaitBudgetMsPerTurn`, then
 * calls `executeFlowTool`. All counters returned are cumulative for the turn.
 */
export async function runFlowToolCall(
  params: RunFlowToolCallParams,
): Promise<RunFlowToolCallResult> {
  const { ctx, toolCallId, bound, input, budget, counters, signal } = params;
  const flowName = bound.targetName;
  const name = bound.tool.name;

  if (signal?.aborted) {
    return buildResult(
      counters,
      {
        toolCallId,
        name,
        kind: 'flow',
        mode: 'auto',
        status: 'not_executed',
        errorCode: 'chat.turn_aborted',
      },
      { ok: false, code: 'chat.turn_aborted', flow: flowName },
      {
        type: 'tool.failed',
        toolCallId,
        name,
        kind: 'flow',
        code: 'chat.turn_aborted',
        message: 'Turn aborted before the flow started.',
      },
    );
  }

  if (counters.flowStartsUsed >= budget.maxFlowStartsPerTurn) {
    return buildResult(
      counters,
      {
        toolCallId,
        name,
        kind: 'flow',
        mode: 'auto',
        status: 'not_executed',
        errorCode: 'chat.flow_start_budget_exceeded',
      },
      { ok: false, code: 'chat.flow_start_budget_exceeded', flow: flowName },
      {
        type: 'tool.failed',
        toolCallId,
        name,
        kind: 'flow',
        code: 'chat.flow_start_budget_exceeded',
        message: `Flow start budget (${budget.maxFlowStartsPerTurn}) exhausted for this turn.`,
      },
    );
  }

  const remainingBudget = Math.max(0, budget.flowAwaitBudgetMsPerTurn - counters.flowAwaitMsUsed);
  const awaitMs = Math.min(budget.flowAwaitMs, remainingBudget);

  let result: ExecuteFlowToolResult;
  try {
    result = await executeFlowTool({
      ctx,
      flowName,
      input,
      awaitMs,
      pollIntervalMs: budget.flowPollIntervalMs,
      signal,
    });
  } catch (err) {
    // Flow is registered; a `start` throw means the engine rejected the input.
    const message = err instanceof Error ? err.message : String(err);
    return buildResult(
      counters,
      {
        toolCallId,
        name,
        kind: 'flow',
        mode: 'auto',
        status: 'not_executed',
        errorCode: 'chat.tool_arguments_invalid',
      },
      { ok: false, code: 'chat.tool_arguments_invalid', flow: flowName },
      {
        type: 'tool.failed',
        toolCallId,
        name,
        kind: 'flow',
        code: 'chat.tool_arguments_invalid',
        message,
      },
    );
  }

  const nextCounters: FlowToolTurnCounters = {
    flowStartsUsed: counters.flowStartsUsed + 1,
    flowAwaitMsUsed: counters.flowAwaitMsUsed + result.awaitMsUsed,
  };

  const record: ToolExecutionRecord = {
    toolCallId,
    name,
    kind: 'flow',
    mode: 'auto',
    status: result.status,
    executionId: result.executionId,
  };

  if (result.status === 'completed' || result.status === 'in_progress') {
    const projection = { executionId: result.executionId, status: result.status };
    const observation =
      result.status === 'completed'
        ? { ok: true, flow: flowName, executionId: result.executionId, status: 'completed' }
        : {
            ok: true,
            flow: flowName,
            executionId: result.executionId,
            status: 'in_progress',
            message: 'Flow started and is still running; result not yet available.',
          };
    return buildResult(
      nextCounters,
      record,
      observation,
      { type: 'tool.completed', toolCallId, name, kind: 'flow', projection },
      result.awaitBudgetElapsed,
    );
  }

  // failed | cancelled | indeterminate
  record.errorCode = 'chat.tool_failed';
  return buildResult(
    nextCounters,
    record,
    {
      ok: false,
      flow: flowName,
      executionId: result.executionId,
      status: result.status,
      code: 'chat.tool_failed',
    },
    {
      type: 'tool.failed',
      toolCallId,
      name,
      kind: 'flow',
      code: 'chat.tool_failed',
      message: `Flow "${flowName}" ended with status "${result.status}".`,
    },
    result.awaitBudgetElapsed,
  );
}
