// packages/chat/src/runtime/tool-phase.ts
import type { AIToolCall, ChatMessage, ExecutionContext } from '@plumbus/core';
import { executeCapability, safeJsonStringify } from '@plumbus/core';
import type { BoundChatTool } from './bind-tools.js';
import {
  runFlowToolCall,
  type FlowToolTurnBudget,
  type FlowToolTurnCounters,
} from './execute-flow-tool.js';
import type { ChatEvent } from '../types/event.js';
import type { ToolExecutionRecord } from '../types/tool.js';

const MAX_OBSERVATION_BYTES = 8 * 1024;
const MAX_ANSWER_OBS_BYTES = 16 * 1024;
const MAX_ARGS_PREVIEW_BYTES = 2 * 1024;

function execCtxWithSignal(ctx: ExecutionContext, signal?: AbortSignal): ExecutionContext {
  return signal ? { ...ctx, signal } : ctx;
}

export interface RunToolPhaseArgs {
  ctx: ExecutionContext;
  chatName: string;
  boundTools: BoundChatTool[];
  systemPrompt: string;
  userMessage: string;
  history: ChatMessage[];
  maxToolRounds: number;
  signal?: AbortSignal;
  emit: (evt: ChatEvent) => void;
  flowBudget?: FlowToolTurnBudget;
  flowCounters?: FlowToolTurnCounters;
  /** When false, argsPreview is omitted from execution records (client-mode persistence). */
  persistToolArgs?: boolean;
}

export interface ToolPhasePause {
  toolCallId: string;
  bound: BoundChatTool;
  rawArguments: unknown;
  confirmationMessage: string;
  /** Native tool transcript accumulated before the confirm pause. */
  exchange: ChatMessage[];
}

export type ToolPhaseResult =
  | {
      status: 'completed';
      toolsExecuted: ToolExecutionRecord[];
      /** Compact JSON of {name, ok, result?/code?} for grounding the answer phase; <=16 KiB. */
      observationsForAnswer: string;
      rounds: number;
      roundLimitReached: boolean;
      usage: { tokensIn: number; tokensOut: number };
      cost: number;
    }
  | {
      status: 'paused';
      pause: ToolPhasePause;
      toolsExecuted: ToolExecutionRecord[];
      rounds: number;
      usage: { tokensIn: number; tokensOut: number };
      cost: number;
    };

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Bounded JSON string; always valid JSON (never raw slice + suffix). */
function truncateJson(value: unknown, maxBytes: number): string {
  const json = safeJsonStringify(value);
  if (byteLength(json) <= maxBytes) return json;

  let preview = json;
  while (preview.length > 0) {
    const candidate = safeJsonStringify({ truncated: true, preview });
    if (byteLength(candidate) <= maxBytes) return candidate;
    preview = preview.slice(0, Math.floor(preview.length / 2));
  }

  return safeJsonStringify({ truncated: true });
}

function toolKind(bound: BoundChatTool | undefined, callName: string): 'capability' | 'flow' {
  if (bound?.kind === 'flow') return 'flow';
  if (callName.startsWith('flow__')) return 'flow';
  return 'capability';
}

function confirmMessage(bound: BoundChatTool): string {
  const label = bound.tool.description?.trim() || bound.tool.name;
  return `Confirm: ${label}?`;
}

export async function runToolPhase(args: RunToolPhaseArgs): Promise<ToolPhaseResult> {
  const { ctx, boundTools, emit } = args;
  const flowCounters: FlowToolTurnCounters = args.flowCounters ?? {
    flowStartsUsed: 0,
    flowAwaitMsUsed: 0,
  };
  const persistToolArgs = args.persistToolArgs ?? true;

  const emptyCompleted = (): ToolPhaseResult => ({
    status: 'completed',
    toolsExecuted: [],
    observationsForAnswer: '[]',
    rounds: 0,
    roundLimitReached: false,
    usage: { tokensIn: 0, tokensOut: 0 },
    cost: 0,
  });

  if (boundTools.length === 0) return emptyCompleted();

  const byName = new Map(boundTools.map((b) => [b.tool.name, b]));
  const providerTools = boundTools.map((b) => b.tool);

  const baseThread: ChatMessage[] = [...args.history, { role: 'user', content: args.userMessage }];
  const exchange: ChatMessage[] = [];
  const toolsExecuted: ToolExecutionRecord[] = [];
  const answerObs: Record<string, unknown>[] = [];

  let usageIn = 0;
  let usageOut = 0;
  let cost = 0;
  let rounds = 0;
  let roundLimitReached = false;
  let pausePayload: ToolPhasePause | undefined;

  const argsPreviewFor = (normalized: unknown): unknown | undefined => {
    if (!persistToolArgs) return undefined;
    return truncateJson(normalized, MAX_ARGS_PREVIEW_BYTES);
  };

  const processCall = async (call: AIToolCall): Promise<string | null> => {
    const boundLookup = byName.get(call.name);
    const kind = toolKind(boundLookup, call.name);

    if (call.argumentsStatus === 'invalid') {
      emit({ type: 'tool.started', toolCallId: call.id, name: call.name, kind });
      toolsExecuted.push({
        toolCallId: call.id,
        name: call.name,
        kind,
        mode: boundLookup?.mode ?? 'auto',
        status: 'not_executed',
        errorCode: 'chat.tool_arguments_invalid',
      });
      emit({
        type: 'tool.failed',
        toolCallId: call.id,
        name: call.name,
        kind,
        code: 'chat.tool_arguments_invalid',
        message: 'Tool arguments could not be parsed',
      });
      answerObs.push({ name: call.name, ok: false, code: 'chat.tool_arguments_invalid' });
      return safeJsonStringify({ ok: false, code: 'tool_arguments_invalid' });
    }

    const bound = boundLookup;
    emit({ type: 'tool.started', toolCallId: call.id, name: call.name, kind });

    if (!bound) {
      toolsExecuted.push({
        toolCallId: call.id,
        name: call.name,
        kind: 'capability',
        mode: 'auto',
        status: 'not_executed',
        errorCode: 'chat.tool_not_bound',
      });
      emit({
        type: 'tool.failed',
        toolCallId: call.id,
        name: call.name,
        kind: 'capability',
        code: 'chat.tool_not_bound',
        message: 'Requested tool is not bound for this turn',
      });
      answerObs.push({ name: call.name, ok: false, code: 'chat.tool_not_bound' });
      return safeJsonStringify({ ok: false, code: 'chat.tool_not_bound' });
    }

    if (bound.mode === 'confirm') {
      const cap = ctx.__runtime?.resolveCapability?.(bound.targetName);
      if (!cap) {
        toolsExecuted.push({
          toolCallId: call.id,
          name: call.name,
          kind: 'capability',
          mode: 'confirm',
          status: 'not_executed',
          errorCode: 'chat.tool_unknown_capability',
        });
        emit({
          type: 'tool.failed',
          toolCallId: call.id,
          name: call.name,
          kind: 'capability',
          code: 'chat.tool_unknown_capability',
          message: `Capability "${bound.targetName}" cannot be resolved`,
        });
        answerObs.push({ name: call.name, ok: false, code: 'chat.tool_unknown_capability' });
        return safeJsonStringify({ ok: false, code: 'chat.tool_unknown_capability' });
      }

      const parsed = cap.input.safeParse(call.arguments);
      if (!parsed.success) {
        toolsExecuted.push({
          toolCallId: call.id,
          name: call.name,
          kind: 'capability',
          mode: 'confirm',
          status: 'not_executed',
          errorCode: 'chat.tool_arguments_invalid',
        });
        emit({
          type: 'tool.failed',
          toolCallId: call.id,
          name: call.name,
          kind: 'capability',
          code: 'chat.tool_arguments_invalid',
          message: 'Tool arguments failed validation',
        });
        answerObs.push({ name: call.name, ok: false, code: 'chat.tool_arguments_invalid' });
        return safeJsonStringify({ ok: false, code: 'tool_arguments_invalid' });
      }

      toolsExecuted.push({
        toolCallId: call.id,
        name: call.name,
        kind: 'capability',
        mode: 'confirm',
        status: 'confirm_pending',
        argsPreview: argsPreviewFor(parsed.data),
      });
      pausePayload = {
        toolCallId: call.id,
        bound,
        rawArguments: call.arguments,
        confirmationMessage: confirmMessage(bound),
        exchange: [],
      };
      return null;
    }

    if (bound.kind === 'flow') {
      const toolBudget: FlowToolTurnBudget = args.flowBudget ?? {
        maxFlowStartsPerTurn: 2,
        flowAwaitBudgetMsPerTurn: 15_000,
        flowAwaitMs: 10_000,
        flowPollIntervalMs: 250,
      };
      const flowRun = await runFlowToolCall({
        ctx,
        toolCallId: call.id,
        bound: { kind: 'flow', targetName: bound.targetName, tool: { name: bound.tool.name } },
        input: call.arguments,
        budget: toolBudget,
        counters: flowCounters,
        signal: args.signal,
      });
      flowCounters.flowStartsUsed = flowRun.counters.flowStartsUsed;
      flowCounters.flowAwaitMsUsed = flowRun.counters.flowAwaitMsUsed;
      emit(flowRun.toolEvent);
      toolsExecuted.push(flowRun.record);
      try {
        answerObs.push(JSON.parse(flowRun.observation) as Record<string, unknown>);
      } catch {
        answerObs.push({ name: call.name, ok: false, code: 'chat.tool_failed' });
      }
      return flowRun.observation;
    }

    const capKind = 'capability' as const;
    const cap = ctx.__runtime?.resolveCapability?.(bound.targetName);
    if (!cap) {
      toolsExecuted.push({
        toolCallId: call.id,
        name: call.name,
        kind: capKind,
        mode: 'auto',
        status: 'not_executed',
        errorCode: 'chat.tool_unknown_capability',
      });
      emit({
        type: 'tool.failed',
        toolCallId: call.id,
        name: call.name,
        kind: capKind,
        code: 'chat.tool_unknown_capability',
        message: `Capability "${bound.targetName}" cannot be resolved`,
      });
      answerObs.push({ name: call.name, ok: false, code: 'chat.tool_unknown_capability' });
      return safeJsonStringify({ ok: false, code: 'chat.tool_unknown_capability' });
    }

    const parsed = cap.input.safeParse(call.arguments);
    const argsPreview = parsed.success ? argsPreviewFor(parsed.data) : undefined;

    const result = await executeCapability(
      cap,
      execCtxWithSignal(ctx, args.signal),
      call.arguments,
    );
    if (result.success) {
      toolsExecuted.push({
        toolCallId: call.id,
        name: call.name,
        kind: capKind,
        mode: 'auto',
        status: 'completed',
        argsPreview,
      });
      emit({ type: 'tool.completed', toolCallId: call.id, name: call.name, kind: capKind });
      answerObs.push({ name: call.name, ok: true, result: result.data });
      return truncateJson({ ok: true, value: result.data }, MAX_OBSERVATION_BYTES);
    }

    const denied = result.error.code === 'forbidden';
    const code = denied ? 'chat.tool_access_denied' : 'chat.tool_failed';
    toolsExecuted.push({
      toolCallId: call.id,
      name: call.name,
      kind: capKind,
      mode: 'auto',
      status: 'failed',
      errorCode: code,
      argsPreview,
    });
    emit({
      type: 'tool.failed',
      toolCallId: call.id,
      name: call.name,
      kind: capKind,
      code,
      message: result.error.message,
    });
    answerObs.push({ name: call.name, ok: false, code });
    return safeJsonStringify({ ok: false, code });
  };

  while (rounds < args.maxToolRounds) {
    rounds++;
    const res = await ctx.ai.generateWithUsage({
      prompt: 'chat.toolRound',
      input: { systemPrompt: args.systemPrompt, userMessage: args.userMessage },
      messages: [...baseThread, ...exchange],
      tools: providerTools,
      toolChoice: 'auto',
      toolExecution: { parallelToolCalls: false },
      outputValidation: 'none',
      signal: args.signal,
      costContext: { serviceArea: 'chat', operationName: `chat.${args.chatName}.toolRound` },
    });
    usageIn += res.usage?.inputTokens ?? 0;
    usageOut += res.usage?.outputTokens ?? 0;
    cost += res.cost ?? 0;

    if (res.finishReason !== 'tool_calls') {
      return {
        status: 'completed',
        toolsExecuted,
        observationsForAnswer: truncateJson(answerObs, MAX_ANSWER_OBS_BYTES),
        rounds,
        roundLimitReached,
        usage: { tokensIn: usageIn, tokensOut: usageOut },
        cost,
      };
    }

    const batchCalls: AIToolCall[] = [];
    const toolMessages: ChatMessage[] = [];

    for (const call of res.toolCalls) {
      if (pausePayload) {
        emit({
          type: 'notice',
          code: 'chat.tool_not_executed_confirmation_boundary',
          message: `Tool "${call.name}" was not executed because confirmation is pending`,
        });
        continue;
      }
      batchCalls.push(call);
      const observation = await processCall(call);
      if (pausePayload) break;
      if (observation !== null) {
        toolMessages.push({
          role: 'tool',
          content: observation,
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    if (batchCalls.length > 0) {
      exchange.push({ role: 'assistant', content: '', toolCalls: batchCalls });
      exchange.push(...toolMessages);
    }

    if (pausePayload) {
      pausePayload.exchange = [...exchange];
      return {
        status: 'paused',
        pause: pausePayload,
        toolsExecuted,
        rounds,
        usage: { tokensIn: usageIn, tokensOut: usageOut },
        cost,
      };
    }
  }

  roundLimitReached = true;
  return {
    status: 'completed',
    toolsExecuted,
    observationsForAnswer: truncateJson(answerObs, MAX_ANSWER_OBS_BYTES),
    rounds,
    roundLimitReached,
    usage: { tokensIn: usageIn, tokensOut: usageOut },
    cost,
  };
}
