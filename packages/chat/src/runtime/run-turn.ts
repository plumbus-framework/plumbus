import type { ChatMessage, ExecutionContext } from '@plumbus/core';
import { checkBudgetPreflight } from '../budget/enforcer.js';
import { trimContextToBudget } from '../budget/context-budget.js';
import { withTurnTimeout } from '../budget/timeout.js';
import { resolveContextSources } from '../context/resolver.js';
import { maybeSummarize } from '../history/summarizer.js';
import { loadHistoryWindow } from '../history/window.js';
import { chatTurnRepo } from '../internal/chat-repos.js';
import { compilePolicy } from '../policy/registry.js';
import { buildSystemPrompt } from '../prompt/build-system-prompt.js';
import { chatTurnPrompt } from '../prompt/chat-turn.prompt.js';
import type { ChatTurnModelOutput } from '../prompt/chat-turn.prompt.js';
import { appendTurn, loadSession } from '../session/service.js';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatEvent } from '../types/event.js';
import type { GuardState } from '../types/policy.js';
import type { ChatSourceRef } from '../types/context.js';
import type { TraceRecorder } from '../eval/trace.js';
import { capClientHistory } from './constants.js';
import { ChatEventEmitter, emitterToIterable } from './events.js';
import { storePending } from './pending-actions.js';
import { chatRefusalRecordedEvent, chatTurnCompletedEvent } from '../events/chat-events.js';

export interface RunChatTurnArgs {
  chatDefinition: ChatDefinition;
  sessionId: string;
  userMessage: string;
  audience: string;
  locale: string;
  clientHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  traceRecorder?: TraceRecorder;
}

const defaultModelOutput = (): ChatTurnModelOutput => ({
  inScope: true,
  answer: '',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
});

export async function* runChatTurn(
  ctx: ExecutionContext,
  args: RunChatTurnArgs,
): AsyncIterable<ChatEvent> {
  const emitter = new ChatEventEmitter();
  const iterable = emitterToIterable(emitter);
  const trace = args.traceRecorder;

  // Wrap emit so every event also lands in the trace. Keeps run-turn pipeline
  // observable end-to-end without scattering `trace?.recordEvent(...)` calls.
  const emit = (evt: ChatEvent): void => {
    trace?.recordEvent(evt);
    emitter.emit(evt);
  };

  void (async () => {
    const turnId = crypto.randomUUID();
    const chat = args.chatDefinition;
    const persistence = chat.persistence?.messageContent ?? 'server';

    try {
      const session = await loadSession(ctx, args.sessionId);
      if (!session) {
        emit({
          type: 'turn.failed',
          code: 'chat.session_not_found',
          message: 'Session not found',
        });
        emitter.end();
        return;
      }

      const ordinal = await aggregateTurnCount(ctx, args.sessionId);
      emit({ type: 'turn.started', turnId, ordinal });

      await checkBudgetPreflight(ctx, {
        chatName: chat.name,
        userId: session.userId,
        tenantId: session.tenantId,
        sessionId: args.sessionId,
        budget: chat.budget,
      });

      const policy = chat.policy ?? {};
      const { preTurnGuards, postTurnGuards } = compilePolicy(policy);
      const turnCtx = {
        sessionId: args.sessionId,
        ordinal,
        userId: session.userId,
        tenantId: session.tenantId,
        audience: args.audience,
        locale: args.locale,
        signal: AbortSignal.timeout((chat.budget?.timeout?.perTurnSeconds ?? 120) * 1000),
        traceId: turnId,
      };

      const guardState: GuardState = {
        ctx,
        chatName: chat.name,
        policy,
        resolvedSources: new Set<string>(),
      };

      for (const guard of preTurnGuards) {
        const verdict = await guard(turnCtx, guardState);
        trace?.recordGuard(guard.name || 'anonymous', verdict);
        if (verdict.decision === 'block') {
          if (verdict.emit) emit(verdict.emit as ChatEvent);
          emit({
            type: 'turn.failed',
            code: verdict.reason,
            message: verdict.reason,
          });
          emitter.end();
          return;
        }
      }

      const resolvedRaw = await resolveContextSources(ctx, chat.context ?? [], turnCtx, {
        perSourceTimeoutMs: 5000,
        onError: 'skip',
      });
      trace?.recordResolved(resolvedRaw);

      for (const src of resolvedRaw.sourceRefs) {
        guardState.resolvedSources?.add(src.id);
        emit({ type: 'source.added', source: src });
      }

      let resolved = resolvedRaw;
      if (chat.budget?.contextTokens) {
        const trimmed = trimContextToBudget(resolved, chat.budget.contextTokens);
        resolved = { ...trimmed, sourceRefs: resolvedRaw.sourceRefs };
      }

      const historyMessages =
        persistence === 'client'
          ? capClientHistory(args.clientHistory)
          : await loadHistoryWindow(
              ctx,
              args.sessionId,
              chat.history?.includeLastTurns ?? 8,
              persistence,
            );

      const historyRows = await loadTurnRows(ctx, args.sessionId);
      const summaryResult = await maybeSummarize(
        ctx,
        session,
        historyRows,
        chat.history?.summarize,
      );

      const systemPrompt = buildSystemPrompt({
        chatInstructions: (chat.instructions ?? []).join('\n'),
        audience: args.audience,
        locale: args.locale,
        scopeDescription: policy.scope?.description,
        resolvedContext: resolved,
        allowedSourceHandles: [...(guardState.resolvedSources ?? [])],
        summary: summaryResult?.summary,
      });
      trace?.recordPrompt(systemPrompt);

      const promptName = chat.prompt?.name ?? chatTurnPrompt.name;
      const userPayload = {
        systemPrompt,
        userMessage: args.userMessage,
        history: historyMessages,
      };

      let modelOutput = defaultModelOutput();
      let usage = { tokensIn: 0, tokensOut: 0 };
      let model = 'unknown';
      let cost = 0;

      // Track whether streaming actually delivered a validated `done` payload.
      // We MUST NOT fall back to non-streaming `generateWithUsage` just because
      // `answer` is empty — legitimate refusals (`inScope: false`) produce an
      // empty answer string with a non-null `refusalReason` and need no second
      // model call. Falling back on empty answer would double-charge every
      // refusal turn.
      let streamCompleted = false;

      const threadMessages: ChatMessage[] = historyMessages
        .filter(
          (m): m is { role: 'user' | 'assistant'; content: string } =>
            m.role === 'user' || m.role === 'assistant',
        )
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const stream = ctx.ai.streamGenerate({
          prompt: promptName,
          input: userPayload,
          messages: [...threadMessages, { role: 'user', content: args.userMessage }],
          signal: withTurnTimeout(
            turnCtx.signal,
            (chat.budget?.timeout?.perTurnSeconds ?? 120) * 1000,
          ),
          costContext: { serviceArea: 'chat', operationName: `chat.${chat.name}` },
        });

        for await (const chunk of stream) {
          if (chunk.type === 'delta' && chunk.text) {
            emit({ type: 'message.delta', text: chunk.text });
          }
          if (chunk.type === 'done') {
            streamCompleted = true;
            if (chunk.data) {
              modelOutput = chunk.data as ChatTurnModelOutput;
            }
            if (chunk.usage) {
              usage = {
                tokensIn: chunk.usage.inputTokens,
                tokensOut: chunk.usage.outputTokens,
              };
            }
            if (chunk.model) model = chunk.model;
            if (chunk.cost != null) cost = chunk.cost;
          }
        }
      } catch {
        // Stream threw — fall through to non-stream generate below.
      }

      // Only fall back when streaming never produced a validated `done` payload.
      // This is the genuine "provider didn't deliver clean structured output"
      // case the plan intended (Task 7.2 fallback).
      if (!streamCompleted) {
        const gen = await ctx.ai.generateWithUsage({
          prompt: promptName,
          input: userPayload,
          costContext: { serviceArea: 'chat', operationName: `chat.${chat.name}` },
        });
        modelOutput = gen.data as ChatTurnModelOutput;
        usage = {
          tokensIn: gen.usage?.inputTokens ?? 0,
          tokensOut: gen.usage?.outputTokens ?? 0,
        };
        model = gen.model;
        cost = gen.cost ?? 0;
        if (modelOutput.answer) {
          emit({ type: 'message.delta', text: modelOutput.answer });
        }
      }

      guardState.modelOutput = modelOutput as unknown as Record<string, unknown>;
      trace?.recordModelOutput(guardState.modelOutput);

      for (const guard of postTurnGuards) {
        const verdict = await guard(turnCtx, guardState);
        trace?.recordGuard(guard.name || 'anonymous', verdict);
        if (verdict.decision === 'block') {
          if (verdict.emit) emit(verdict.emit as ChatEvent);
          if (verdict.reason === 'out_of_scope') {
            await ctx.events.emit(chatRefusalRecordedEvent.name, {
              chatName: chat.name,
              sessionId: args.sessionId,
              refusalReason:
                typeof modelOutput.refusalReason === 'string'
                  ? modelOutput.refusalReason
                  : 'off_topic',
            });
          }
        }
        if (verdict.decision === 'require_confirmation') {
          await storePending(ctx, verdict.pendingAction);
          emit({
            type: 'confirmation_required',
            actionId: verdict.pendingAction.id,
            capabilityName: verdict.pendingAction.capabilityName,
            confirmationMessage: verdict.pendingAction.confirmationMessage,
            expiresAt: verdict.pendingAction.expiresAt,
          });
        }
      }

      const finalAnswer =
        typeof guardState.modelOutput?.answer === 'string'
          ? guardState.modelOutput.answer
          : modelOutput.answer;

      // Persist only the sources the model actually cited (validated by the
      // provenance guard above), not every source we retrieved. The retrieved
      // set is debugging data; the cited set is the audit trail.
      const allowedHandles = guardState.resolvedSources ?? new Set<string>();
      const citedHandles: string[] = Array.isArray(guardState.modelOutput?.citedSources)
        ? (guardState.modelOutput!.citedSources as string[]).filter((id) => allowedHandles.has(id))
        : [];
      const citedSourceRefs: ChatSourceRef[] = resolvedRaw.sourceRefs.filter((src) =>
        citedHandles.includes(src.id),
      );

      await appendTurn(
        ctx,
        {
          sessionId: args.sessionId,
          ordinal: 0,
          role: 'user',
          content: args.userMessage,
          inScope: true,
          sources: [],
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          model: '',
          latencyMs: 0,
          recordedAt: ctx.time.now(),
          userId: session.userId,
        },
        { persistContent: persistence !== 'client' },
      );

      await appendTurn(
        ctx,
        {
          sessionId: args.sessionId,
          ordinal: 0,
          role: 'assistant',
          content: finalAnswer,
          inScope: modelOutput.inScope,
          refusalReason: modelOutput.refusalReason ?? undefined,
          sources: citedSourceRefs,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd: cost,
          model,
          latencyMs: 0,
          recordedAt: ctx.time.now(),
          userId: session.userId,
        },
        { persistContent: persistence !== 'client' },
      );

      await ctx.events.emit(chatTurnCompletedEvent.name, {
        chatName: chat.name,
        sessionId: args.sessionId,
        turnId,
        costUsd: cost,
      });
      emit({ type: 'turn.completed', turnId, usage, cost });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'turn.failed', code: 'chat.turn_error', message });
    } finally {
      emitter.end();
    }
  })();

  yield* iterable;
}

async function aggregateTurnCount(ctx: ExecutionContext, sessionId: string): Promise<number> {
  const rows = await chatTurnRepo(ctx).findMany({ sessionId });
  return rows.length;
}

async function loadTurnRows(ctx: ExecutionContext, sessionId: string) {
  return chatTurnRepo(ctx).findMany({ sessionId }, { orderBy: 'ordinal', orderDir: 'asc' });
}
