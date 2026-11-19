import type { CapabilityContract, ChatMessage, ExecutionContext } from '@plumbus/core';
import { trimContextToBudget } from '../budget/context-budget.js';
import { checkBudgetPreflight } from '../budget/enforcer.js';
import { withTurnTimeout } from '../budget/timeout.js';
import { resolveContextSources } from '../context/resolver.js';
import type { TraceRecorder } from '../eval/trace.js';
import { chatRefusalRecordedEvent, chatTurnCompletedEvent } from '../events/chat-events.js';
import { maybeSummarize } from '../history/summarizer.js';
import { loadHistoryWindow } from '../history/window.js';
import { runBehavioralPostGuard } from '../policy/behavioral-guard.js';
import { buildNormalizedPending } from '../policy/pending-action-factory.js';
import { compilePolicy } from '../policy/registry.js';
import { buildSystemPrompt } from '../prompt/build-system-prompt.js';
import { chatScopeCheckPrompt } from '../prompt/chat-scope-check.prompt.js';
import { chatToolRoundPrompt } from '../prompt/chat-tool-round.prompt.js';
import type { ChatTurnModelOutput } from '../prompt/chat-turn.prompt.js';
import { chatTurnPrompt } from '../prompt/chat-turn.prompt.js';
import type { ChatPendingActionV2, ChatToolResumePayloadV1 } from '../session/pending-action-v2.js';
import type { loadSession } from '../session/service.js';
import { type ChatSessionStore, resolveChatSessionStore } from '../session/session-store.js';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatSourceRef } from '../types/context.js';
import type { ChatEvent } from '../types/event.js';
import type { GuardState, GuardVerdict } from '../types/policy.js';
import type { ChatFinalReply, ChatReplyValidator } from '../types/reply.js';
import type { ChatNestedAiCall, ToolExecutionRecord } from '../types/tool.js';
import {
  type BoundChatTool,
  bindChatCapabilityTools,
  bindFlowTools,
  ChatToolBindError,
  resolveToolBinding,
} from './bind-tools.js';
import type { ChatTurnWrite } from './chat-conversation-store.js';
import {
  type ChatConversationStore,
  createChatConversationStore,
} from './chat-conversation-store.js';
import type { ChatRegistry } from './chat-registry.js';
import { clientSafeErrorMessage } from './client-error.js';
import { type ClientHistoryMessage, capClientHistory } from './constants.js';
import { ChatEventEmitter, emitterToIterable } from './events.js';
import {
  answerTextOf,
  ChatRegenerationError,
  clientActionsFromOutput,
  draftMessageOf,
  finalizeReply,
  normalizeClientActions,
} from './reply-finalize.js';
import { runToolPhase } from './tool-phase.js';

export interface RunChatTurnArgs {
  chatDefinition: ChatDefinition;
  sessionId: string;
  userMessage: string;
  audience: string;
  locale: string;
  clientHistory?: ClientHistoryMessage[];
  /**
   * Server-authoritative native history for programmatic chat callers. Unlike
   * browser-owned clientHistory, this is not accepted by registerChatRoutes and
   * is not capped to the public wire limit.
   */
  trustedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Server-owned fields merged into a custom prompt's input. The standard
   * systemPrompt/userMessage/history fields always win. HTTP routes never copy
   * arbitrary request fields into this object.
   */
  promptInput?: Record<string, unknown>;
  /** Caller cancellation (request disconnect, voice interruption, etc.). */
  signal?: AbortSignal;
  traceRecorder?: TraceRecorder;
  /** Injected registry used to fail Path B closed when tool prompts are unregistered (D5). */
  registry?: ChatRegistry;
}

/**
 * Storage injection for one turn. Both fields are optional; omitting them keeps
 * the DB-backed behavior applications already have.
 *
 * Supplying `sessionStore` lets a deployment with no local database run the stock
 * pipeline against its own memory backend (see `docs/chat/session-store.md`).
 * `conversationStore` is the separate atomic tier that tool confirmations and
 * pending actions require; when a `sessionStore` is injected without it,
 * confirmations are refused rather than committed non-atomically.
 */
export interface RunChatTurnOpts {
  sessionStore?: ChatSessionStore;
  conversationStore?: ChatConversationStore;
  /**
   * Supported binding path for programmatic calls made inside a capability,
   * where core deliberately hides ctx.__runtime.resolveCapability. Returned
   * contracts still execute through executeCapability with normal access checks.
   */
  resolveCapability?: (name: string) => CapabilityContract<any, any> | undefined;
  /**
   * Server-only observer for successful `generateWithUsage` / `streamGenerate`
   * calls made inside auto capability tools. Useful for attributing nested
   * provider spend without removing it from Chat's logical-turn budget total.
   */
  onNestedAiCall?: (call: ChatNestedAiCall) => void;
  /** Server-only observer of the custom agent prompt's validated final output.
   * Structured application metadata is not emitted to clients or rewritten. */
  onAgentOutput?: (output: unknown) => void;
  /**
   * App check on the finished reply, run BEFORE the assistant turn is written.
   * It accepts the reply or replaces it with app text and a moderation code;
   * only the accepted or replacement text is persisted. When the draft was
   * already streamed, a `message.replaced` event tells the client to swap the
   * bubble. See {@link ChatReplyValidator}.
   */
  validateReply?: ChatReplyValidator;
  /**
   * How many times one turn may act on a `regenerate` verdict (each one a model
   * call through `ctx.ai`, counted in the turn's usage, cost and caps).
   * Integer 0..3, default 1. Past it a `regenerate` ends in its `fallback`.
   */
  maxRegenerations?: number;
}

const defaultModelOutput = (): ChatTurnModelOutput => ({
  inScope: true,
  answer: '',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
});

/**
 * The chat's view of a custom prompt's completion: the output itself, with
 * `answer` read through the chat's `answerOf` when it declares one. The raw
 * output is kept separately as `structuredOutput` for `validateReply`.
 */
function chatModelOutputOf(chat: ChatDefinition, data: unknown): ChatTurnModelOutput {
  if (!chat.answerOf) return data as ChatTurnModelOutput;
  const base = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    ...defaultModelOutput(),
    ...base,
    answer: answerTextOf(chat, data),
  } as ChatTurnModelOutput;
}

/** Per-call AI overrides of `policy.toolCalling.ai`, for agent completions. */
function toolAiOverrides(chat: ChatDefinition): Record<string, unknown> {
  const ai = chat.policy?.toolCalling?.ai;
  return {
    ...(ai?.provider ? { provider: ai.provider } : {}),
    ...(ai?.model ? { model: ai.model } : {}),
    ...(ai?.reasoning !== undefined ? { reasoning: ai.reasoning } : {}),
    ...(ai?.reasoningEffort !== undefined ? { reasoningEffort: ai.reasoningEffort } : {}),
  };
}

function hasToolAiOverride(chat: ChatDefinition): boolean {
  if (chat.policy?.toolCalling?.enabled !== true) return false;
  const ai = chat.policy?.toolCalling?.ai;
  return Boolean(
    ai &&
      (ai.provider !== undefined ||
        ai.model !== undefined ||
        ai.reasoning !== undefined ||
        ai.reasoningEffort !== undefined),
  );
}

type ChatTurnFailedEvent = Extract<ChatEvent, { type: 'turn.failed' }>;

function toolAiOverrideCompatibilityFailure(
  ctx: ExecutionContext,
  chat: ChatDefinition,
): ChatTurnFailedEvent | undefined {
  if (hasToolAiOverride(chat) && ctx.ai.features?.perCallProviderModelReasoning !== true) {
    return {
      type: 'turn.failed',
      code: 'chat.core_version_unsupported',
      message: `Chat "${chat.name}" policy.toolCalling.ai requires @plumbus/core >= 0.6.18`,
    };
  }
  return undefined;
}

export async function* runChatTurn(
  ctx: ExecutionContext,
  args: RunChatTurnArgs,
  opts?: RunChatTurnOpts,
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

  const sessionStore = resolveChatSessionStore(opts?.sessionStore);

  /**
   * Tier 2 (atomic multi-row commits) for the confirmation paths.
   *
   * Legacy behavior is preserved exactly: with no injection at all we build the
   * ctx-backed store, which still throws `chat.storage_unsupported` when the
   * wired repositories lack a conditional-write path. Only when a caller has
   * injected a tier-1 `sessionStore` but no `conversationStore` do we return
   * null, so the confirmation sites can refuse cleanly instead of committing a
   * proposal the store cannot make atomic.
   */
  const resolveConversationStore = (): ChatConversationStore | null => {
    if (opts?.conversationStore) return opts.conversationStore;
    if (opts?.sessionStore) return null;
    return createChatConversationStore(ctx);
  };

  void (async () => {
    const turnId = crypto.randomUUID();
    const chat = args.chatDefinition;
    const persistence = chat.persistence?.messageContent ?? 'server';
    const saveToDb = chat.persistence?.saveToDb ?? true;

    try {
      // In ephemeral mode (`saveToDb: false`) there's no chat_session row to
      // load. Synthesize a minimal stand-in from the request so downstream
      // code that reads `session.userId` / `session.tenantId` works uniformly.
      // Cast covers ChatSessionRow's other fields, none of which are accessed
      // in this code path (history summarizer + DB writes are both skipped
      // when `saveToDb: false`).
      //
      // In DB mode (`saveToDb: true`), the client may have generated its own
      // sessionId without a separate bootstrap (e.g. help widgets where the
      // browser owns the UUID). `getOrCreateSession` looks up the row and
      // inserts it on first turn — wiring identity from ctx.auth + the
      // request. This removes the need for consumers to ship a separate
      // `chatStart` capability.
      const session = saveToDb
        ? await sessionStore.getOrCreateSession(ctx, {
            sessionId: args.sessionId,
            chatName: chat.name,
            userId: (ctx.auth as { userId?: string }).userId ?? '',
            audience: args.audience,
            locale: args.locale,
            tenantId: (ctx.auth as { tenantId?: string }).tenantId,
          })
        : ({
            id: args.sessionId,
            userId: (ctx.auth as { userId?: string }).userId ?? 'ephemeral',
            tenantId: (ctx.auth as { tenantId?: string }).tenantId,
          } as unknown as Awaited<ReturnType<typeof loadSession>>);
      // A session is bound to the chat it was created for. Built-in stores refuse
      // a mismatch already; this also covers injected stores that only check the
      // owner. Same error as the store's ownership refusal. A row with no chatName
      // (a custom store that does not record it) is not refused.
      if (
        session &&
        saveToDb &&
        typeof session.chatName === 'string' &&
        session.chatName !== '' &&
        session.chatName !== chat.name
      ) {
        throw ctx.errors.notFound('Session not found', { sessionId: args.sessionId });
      }
      if (!session) {
        emit({
          type: 'turn.failed',
          code: 'chat.session_not_found',
          message: 'Session not found',
        });
        emitter.end();
        return;
      }

      // Ordinal: when DB-backed, count existing rows. When ephemeral, the
      // client-supplied history length is the best proxy (the new user message
      // about to be sent makes this turn ordinal N = past message count).
      const ordinal = saveToDb
        ? await sessionStore.countTurns(ctx, args.sessionId)
        : (args.clientHistory?.length ?? 0);
      emit({ type: 'turn.started', turnId, ordinal });

      // Per-tenant / per-user / per-day budgets aggregate across sessions —
      // they require DB. Per-session message-cap is enforced inline below
      // (against clientHistory) when ephemeral.
      if (saveToDb) {
        await checkBudgetPreflight(ctx, {
          chatName: chat.name,
          userId: session.userId,
          tenantId: session.tenantId,
          sessionId: args.sessionId,
          budget: chat.budget,
          sessionStore: opts?.sessionStore,
        });
      } else {
        const cap = chat.budget?.perSession?.userMessages;
        if (cap !== undefined) {
          const priorUserMessages = (args.clientHistory ?? []).filter(
            (m) => m.role === 'user',
          ).length;
          // +1 for the incoming turn's user message
          if (priorUserMessages + 1 > cap) {
            emit({
              type: 'notice',
              code: 'chat.budget_exceeded',
              message: `Session message cap reached (${cap})`,
            });
            emit({
              type: 'turn.failed',
              code: 'chat.budget_exceeded',
              message: `Session message cap reached (${cap})`,
            });
            emitter.end();
            return;
          }
        }
      }

      const policy = chat.policy ?? {};
      const toolCallingEnabled = policy.toolCalling?.enabled === true;
      const toolOrchestration = policy.toolCalling?.orchestration ?? 'staged';
      const compatibilityFailure = toolAiOverrideCompatibilityFailure(ctx, chat);
      if (compatibilityFailure) {
        emit(compatibilityFailure);
        return;
      }
      const scopePreflightEnabled =
        policy.toolCalling?.scopePreflight ?? toolOrchestration === 'staged';
      let toolsExecuted: ToolExecutionRecord[] = [];
      let toolPhaseTokensIn = 0;
      let toolPhaseTokensOut = 0;
      let toolPhaseCost = 0;
      let scopeInScope: boolean | undefined =
        toolCallingEnabled && !scopePreflightEnabled ? true : undefined;
      let skipAnswerGeneration = false;
      let proposalCommitted = false;
      // Agent orchestration: the thread the final answer was written on (for a regeneration).
      let agentThread: ChatMessage[] | undefined;
      const { preTurnGuards, postTurnGuards } = compilePolicy(policy);
      const timeoutSignal = AbortSignal.timeout(
        (chat.budget?.timeout?.perTurnSeconds ?? 120) * 1000,
      );
      const turnCtx = {
        sessionId: args.sessionId,
        ordinal,
        userId: session.userId,
        tenantId: session.tenantId,
        audience: args.audience,
        locale: args.locale,
        signal: args.signal ? AbortSignal.any([args.signal, timeoutSignal]) : timeoutSignal,
        traceId: turnId,
        contextTokenBudget: chat.budget?.contextTokens,
        userMessage: args.userMessage,
        applyDefaultAudienceFilter: policy.audience !== undefined,
      };

      const guardState: GuardState = {
        ctx,
        chatName: chat.name,
        policy,
        resolvedSources: new Set<string>(),
        clientHistory: saveToDb ? undefined : (args.clientHistory ?? []),
        saveToDb,
        sessionStore: opts?.sessionStore,
        budgetActionsPerSession: chat.budget?.actions?.perSession,
      };

      for (const guard of preTurnGuards) {
        const verdict = await guard(turnCtx, guardState);
        trace?.recordGuard(guard.name || 'anonymous', verdict);
        if (verdict.decision === 'block') {
          if (verdict.emit) emit(verdict.emit as ChatEvent);
          // Do not re-record cooldown when the block itself is an active cooldown —
          // otherwise retries extend the lockout forever.
          if (verdict.reason !== 'cooldown_active') {
            if (
              verdict.reason === 'provenance_missing' ||
              verdict.reason === 'provenance_insufficient'
            ) {
              guardState.lastBudgetOrGuardSignal = 'budget';
            } else {
              guardState.lastBudgetOrGuardSignal = 'guardFailure';
            }
            await runBehavioralPostGuard(turnCtx, guardState);
          }
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
        perSourceTimeoutMs: chat.contextResolution?.perSourceTimeoutMs ?? 5000,
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

      // Turns sent verbatim from the store; the summary must cover everything before them.
      const storedWindowTurns =
        args.trustedHistory === undefined && persistence === 'server'
          ? (chat.history?.includeLastTurns ?? 8)
          : undefined;
      const historyMessages =
        args.trustedHistory ??
        (persistence === 'client'
          ? capClientHistory(args.clientHistory)
          : await loadHistoryWindow(
              ctx,
              args.sessionId,
              storedWindowTurns ?? 8,
              persistence,
              opts?.sessionStore,
            ));

      // Summarizer reads chat_turn rows. Ephemeral mode has none — skip. A chat
      // without a summarize threshold (the default) reads no turns for it.
      const summarizeConfig = chat.history?.summarize || undefined;
      const summaryResult =
        saveToDb && summarizeConfig?.thresholdTurns
          ? await maybeSummarize(
              ctx,
              session,
              await sessionStore.listTurns(ctx, args.sessionId),
              summarizeConfig,
              opts?.sessionStore,
              {
                conversationLocale:
                  policy.reply?.locale && policy.reply.locale !== 'auto'
                    ? policy.reply.locale
                    : (session.locale ?? args.locale),
                windowTurns: storedWindowTurns,
              },
            )
          : null;

      const systemPrompt = buildSystemPrompt({
        chatInstructions: (chat.instructions ?? []).join('\n'),
        audience: args.audience,
        locale: args.locale,
        replyLocale: policy.reply?.locale,
        scopeDescription: policy.scope?.description,
        resolvedContext: resolved,
        allowedSourceHandles: [...(guardState.resolvedSources ?? [])],
        summary: summaryResult?.summary,
      });
      trace?.recordPrompt(systemPrompt);

      const promptName = chat.prompt?.name ?? chatTurnPrompt.name;
      let userPayload = {
        ...(args.promptInput ?? {}),
        systemPrompt,
        userMessage: args.userMessage,
        history: historyMessages,
      };

      let modelOutput = defaultModelOutput();
      // The prompt's validated structured output, for client actions and validateReply.
      let structuredOutput: unknown;
      let usage = { tokensIn: 0, tokensOut: 0 };
      let model = 'unknown';
      let provider = 'unknown';
      let cost = 0;

      // Track whether streaming actually delivered a validated `done` payload.
      // We MUST NOT fall back to non-streaming `generateWithUsage` just because
      // `answer` is empty — legitimate refusals (`inScope: false`) produce an
      // empty answer string with a non-null `refusalReason` and need no second
      // model call. Falling back on empty answer would double-charge every
      // refusal turn.
      let streamCompleted = false;
      let streamedData: unknown;

      const threadMessages: ChatMessage[] = historyMessages
        .filter(
          (m): m is { role: 'user' | 'assistant'; content: string } =>
            m.role === 'user' || m.role === 'assistant',
        )
        .map((m) => ({ role: m.role, content: m.content }));

      // ── Path B: provider-native tool calling ──
      if (toolCallingEnabled) {
        const requiredPrompts = [
          ...(scopePreflightEnabled ? [chatScopeCheckPrompt.name] : []),
          ...(toolOrchestration === 'staged' ? [chatToolRoundPrompt.name] : []),
        ];

        // 1. Prompt registration — fail closed for the package prompts this
        // orchestration actually uses. Agent mode without scope preflight uses
        // only the chat's own custom prompt, so it needs no package re-export.
        if (requiredPrompts.length > 0 && !args.registry) {
          emit({
            type: 'turn.failed',
            code: 'chat.prompt_not_registered',
            message: `ChatRegistry not provided; cannot verify ${requiredPrompts.join(' / ')} registration`,
          });
          emitter.end();
          return;
        }
        for (const requiredPrompt of requiredPrompts) {
          if (!args.registry?.hasPrompt(requiredPrompt)) {
            emit({
              type: 'turn.failed',
              code: 'chat.prompt_not_registered',
              message: `Prompt "${requiredPrompt}" is not registered — re-export it into app/prompts/`,
            });
            emitter.end();
            return;
          }
        }

        // 2. Optional scope preflight. Staged mode keeps the historical default;
        // agent mode defaults it off so an in-domain no-tool turn is one call.
        try {
          if (!scopePreflightEnabled) {
            scopeInScope = true;
          } else {
            const scope = await ctx.ai.generateWithUsage({
              prompt: chatScopeCheckPrompt.name,
              input: { systemPrompt, userMessage: args.userMessage },
              signal: turnCtx.signal,
              costContext: {
                serviceArea: 'chat',
                operationName: `chat.${chat.name}.scopeCheck`,
              },
            });
            const sd = scope.data as {
              inScope: boolean;
              refusalReason: ChatTurnModelOutput['refusalReason'];
            };
            scopeInScope = sd.inScope === true;
            toolPhaseTokensIn += scope.usage?.inputTokens ?? 0;
            toolPhaseTokensOut += scope.usage?.outputTokens ?? 0;
            toolPhaseCost += scope.cost ?? 0;
            if (!scopeInScope) {
              modelOutput = {
                inScope: false,
                answer: '',
                refusalReason: sd.refusalReason ?? 'off_topic',
                citedSources: [],
                requestedAction: null,
              };
              usage = { tokensIn: toolPhaseTokensIn, tokensOut: toolPhaseTokensOut };
              cost = toolPhaseCost;
              skipAnswerGeneration = true;
            }
          }
        } catch (err) {
          emit({
            type: 'turn.failed',
            code: 'chat.turn_error',
            message: clientSafeErrorMessage(ctx, err, 'scope_preflight'),
          });
          emitter.end();
          return;
        }

        // 3+4. Bind tools + run the tool phase (only when in scope).
        if (scopeInScope) {
          let boundTools: BoundChatTool[];
          try {
            boundTools = bindChatCapabilityTools(ctx, policy.toolCalling?.capabilities ?? [], {
              maxTools: policy.toolCalling?.maxTools ?? 32,
              resolveCapability: opts?.resolveCapability,
              readOnlyQueries: policy.toolCalling?.readOnlyQueries,
            });
          } catch (err) {
            if (err instanceof ChatToolBindError) {
              emit({ type: 'turn.failed', code: err.code, message: err.message });
            } else {
              emit({
                type: 'turn.failed',
                code: 'chat.turn_error',
                message: clientSafeErrorMessage(ctx, err, 'bind_tools'),
              });
            }
            emitter.end();
            return;
          }

          const autoStartFlows = policy.toolCalling?.autoStartFlows ?? [];
          if (autoStartFlows.length > 0) {
            const flowBinding = bindFlowTools(ctx, autoStartFlows);
            if (flowBinding.errors.length > 0) {
              const first = flowBinding.errors[0];
              if (first) {
                emit({ type: 'turn.failed', code: first.code, message: first.message });
              }
              emitter.end();
              return;
            }
            boundTools.push(...flowBinding.tools);
          }

          const flowCounters = { flowStartsUsed: 0, flowAwaitMsUsed: 0 };

          const toolPhase = await runToolPhase({
            ctx,
            chatName: chat.name,
            boundTools,
            systemPrompt,
            userMessage: args.userMessage,
            history: threadMessages,
            maxToolRounds: policy.toolCalling?.maxToolRounds ?? 5,
            ai: policy.toolCalling?.ai,
            includeNestedAiUsage:
              policy.toolCalling?.includeNestedAiUsage ?? toolOrchestration === 'agent',
            onNestedAiCall: opts?.onNestedAiCall,
            onAgentOutput: opts?.onAgentOutput,
            signal: turnCtx.signal,
            emit,
            persistToolArgs: persistence !== 'client',
            ...(toolOrchestration === 'agent'
              ? {
                  agentPrompt: {
                    name: promptName,
                    input: userPayload,
                  },
                }
              : {}),
            flowBudget: {
              maxFlowStartsPerTurn: policy.toolCalling?.maxFlowStartsPerTurn ?? 2,
              flowAwaitBudgetMsPerTurn: policy.toolCalling?.flowAwaitBudgetMsPerTurn ?? 15_000,
              flowAwaitMs: policy.toolCalling?.flowAwaitMs ?? 10_000,
              flowPollIntervalMs: policy.toolCalling?.flowPollIntervalMs ?? 250,
            },
            flowCounters,
          });
          toolsExecuted = toolPhase.toolsExecuted;
          toolPhaseTokensIn += toolPhase.usage.tokensIn;
          toolPhaseTokensOut += toolPhase.usage.tokensOut;
          toolPhaseCost += toolPhase.cost;

          if (toolPhase.status === 'completed' && toolOrchestration === 'agent') {
            agentThread = toolPhase.finalThread;
            modelOutput = {
              inScope: true,
              answer: chat.answerOf
                ? answerTextOf(chat, toolPhase.finalOutput)
                : (toolPhase.finalAnswer ?? ''),
              refusalReason: null,
              citedSources: [],
              requestedAction: null,
            };
            usage = {
              tokensIn: toolPhaseTokensIn,
              tokensOut: toolPhaseTokensOut,
            };
            model = toolPhase.finalModel ?? 'unknown';
            provider = toolPhase.finalProvider ?? 'unknown';
            cost = toolPhaseCost;
            structuredOutput = toolPhase.finalOutput;
            skipAnswerGeneration = true;
          }

          if (toolPhase.status === 'paused') {
            skipAnswerGeneration = true;
            if (!saveToDb) {
              emit({
                type: 'notice',
                code: 'chat.tool_arguments_invalid',
                message: 'Confirmation requires a durable session',
              });
            } else {
              const pause = toolPhase.pause;
              const sourceRefsForResume: ChatSourceRef[] = resolvedRaw.sourceRefs;
              const resumePayload: ChatToolResumePayloadV1 = {
                version: 1,
                chatName: chat.name,
                logicalTurnId: turnId,
                proposalAssistantTurnId: turnId,
                toolCallId: pause.toolCallId,
                toolName: pause.bound.tool.name,
                messages: [
                  ...threadMessages,
                  { role: 'user', content: args.userMessage },
                  ...pause.exchange,
                ],
                counters: {
                  toolRoundsUsed: toolPhase.rounds,
                  flowStartsUsed: flowCounters.flowStartsUsed,
                  flowAwaitMsUsed: flowCounters.flowAwaitMsUsed,
                  inputTokensUsed: toolPhaseTokensIn,
                  outputTokensUsed: toolPhaseTokensOut,
                  costUsed: toolPhaseCost,
                },
                toolsExecuted: toolPhase.toolsExecuted,
                sourceRefs: sourceRefsForResume,
                ...(toolOrchestration === 'agent' ? { agentPromptInput: userPayload } : {}),
              };
              const built = buildNormalizedPending({
                ctx,
                sessionId: args.sessionId,
                expectedSessionRevision: session.revision ?? 0,
                capabilityName: pause.bound.targetName,
                rawInput: pause.rawArguments,
                confirmationMessage: pause.confirmationMessage,
                bindingInputSchemaHash: pause.bound.inputSchemaHash,
                toolBindingHash: pause.bound.toolBindingHash,
                ttlMs: policy.toolCalling?.confirmationTtlMs ?? 900_000,
                resumePayload,
              });
              if (!built.ok) {
                emit({
                  type: 'notice',
                  code: built.code,
                  message: 'Requested action could not be prepared',
                });
              } else {
                const store = resolveConversationStore();
                if (!store) {
                  // Tier-1 store injected without the atomic tier: refuse rather
                  // than commit a proposal that cannot be made atomic.
                  emit({
                    type: 'notice',
                    code: 'chat.storage_unsupported',
                    message:
                      'Confirmations require a conversation store with atomic writes; none was injected',
                  });
                } else {
                  const leaseRes = await store.acquireSessionMutation({
                    sessionId: args.sessionId,
                    ownerToken: crypto.randomUUID(),
                    leaseMs: 30_000,
                  });
                  if (!leaseRes.acquired) {
                    emit({ type: 'notice', code: 'chat.session_busy', message: 'Session is busy' });
                  } else {
                    try {
                      await store.commitProposal({
                        lease: leaseRes.lease,
                        expectedRevision: leaseRes.lease.sessionRevision,
                        userTurn: {
                          role: 'user',
                          content: args.userMessage,
                          inScope: true,
                          sources: [],
                          logicalTurnId: turnId,
                          tokensIn: 0,
                          tokensOut: 0,
                          costUsd: 0,
                          model: '',
                          latencyMs: 0,
                        },
                        assistantTurn: {
                          role: 'assistant',
                          content: built.pending.confirmationMessage,
                          inScope: true,
                          sources: sourceRefsForResume,
                          logicalTurnId: turnId,
                          tokensIn: toolPhaseTokensIn,
                          tokensOut: toolPhaseTokensOut,
                          costUsd: toolPhaseCost,
                          model: '',
                          latencyMs: 0,
                          toolsExecuted: toolPhase.toolsExecuted,
                          actionRequested: {
                            capabilityName: built.pending.capabilityName,
                            input: built.pending.input,
                          },
                        },
                        pending: {
                          ...built.pending,
                          expectedSessionRevision: leaseRes.lease.sessionRevision + 1,
                        },
                      });
                      emit({
                        type: 'confirmation_required',
                        actionId: built.pending.id,
                        capabilityName: built.pending.capabilityName,
                        confirmationMessage: built.pending.confirmationMessage,
                        expiresAt: built.pending.expiresAt,
                        schemaHash: built.pending.inputSchemaHash,
                        inputSchemaHash: built.pending.inputSchemaHash,
                        projection: built.pending.confirmationProjection,
                      });
                      proposalCommitted = true;
                    } finally {
                      await store.releaseSessionMutation({
                        sessionId: args.sessionId,
                        leaseToken: leaseRes.lease.leaseToken,
                      });
                    }
                  }
                }
              }
            }
            if (proposalCommitted) {
              emitter.end();
              return;
            }
          }

          if (toolPhase.status === 'completed' && toolPhase.roundLimitReached) {
            emit({
              type: 'notice',
              code: 'chat.tool_round_limit',
              message: 'Tool round limit reached; answering with results gathered so far',
            });
          }
          if (
            toolOrchestration === 'staged' &&
            toolPhase.status === 'completed' &&
            toolPhase.toolsExecuted.length > 0
          ) {
            userPayload = {
              ...userPayload,
              systemPrompt: `${userPayload.systemPrompt}\n\n## Tool results\nThe following tools ran for this turn. Ground your answer ONLY in these results.\n${JSON.stringify({ type: 'untrusted_tool_result', content: toolPhase.observationsForAnswer })}`,
            };
          }
        }
      }

      if (proposalCommitted) {
        emitter.end();
        return;
      }

      try {
        const stream = skipAnswerGeneration
          ? []
          : ctx.ai.streamGenerate({
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
          // Do NOT emit `chunk.text` as message.delta during streaming. For the
          // structured-output ChatTurnModelOutput schema, `chunk.text` is the
          // raw JSON serialization in progress (e.g. `{"inScope":false,"answe`)
          // — emitting it would dump JSON into the user-facing message bubble.
          // We emit one synthetic message.delta with `modelOutput.answer` after
          // `done` instead. (Token-level streaming of the `answer` field would
          // require diffing partial JSON snapshots — out of scope for v0.1.)
          if (chunk.type === 'done') {
            streamCompleted = true;
            // Read through answerOf after the stream: a broken answerOf must fail
            // the turn, not be taken for a stream failure.
            if (chunk.data) streamedData = chunk.data;
            if (chunk.usage) {
              usage = {
                tokensIn: chunk.usage.inputTokens,
                tokensOut: chunk.usage.outputTokens,
              };
            }
            if (chunk.model) model = chunk.model;
            if (chunk.provider) provider = chunk.provider;
            if (chunk.cost != null) cost = chunk.cost;
          }
        }
      } catch {
        // Stream threw — fall through to non-stream generate below.
      }
      if (streamCompleted && streamedData !== undefined) {
        modelOutput = chatModelOutputOf(chat, streamedData);
        structuredOutput = streamedData;
      }

      // Only fall back when streaming never produced a validated `done` payload.
      // This is the genuine "provider didn't deliver clean structured output"
      // case the plan intended (Task 7.2 fallback).
      if (!streamCompleted && !skipAnswerGeneration) {
        const gen = await ctx.ai.generateWithUsage({
          prompt: promptName,
          input: userPayload,
          costContext: { serviceArea: 'chat', operationName: `chat.${chat.name}` },
        });
        modelOutput = chatModelOutputOf(chat, gen.data);
        structuredOutput = gen.data;
        usage = {
          tokensIn: gen.usage?.inputTokens ?? 0,
          tokensOut: gen.usage?.outputTokens ?? 0,
        };
        model = gen.model;
        provider = gen.provider;
        cost = gen.cost ?? 0;
      }

      if (toolCallingEnabled && !skipAnswerGeneration) {
        usage = {
          tokensIn: usage.tokensIn + toolPhaseTokensIn,
          tokensOut: usage.tokensOut + toolPhaseTokensOut,
        };
        cost += toolPhaseCost;
      }

      // Emit the user-facing answer text as a single delta — same shape both
      // paths (streaming + fallback) so applyChatEvent's accumulator produces
      // clean message content. ALWAYS emit (even when answer is empty) so the
      // accumulator creates an assistant message that turn.completed can then
      // tag with inScope/refusalReason. Without this, empty-answer refusals
      // leave no assistant message in chat-ui state and the refusal bubble
      // never renders client-side — the user sees nothing despite the server
      // having recorded a refusal (and the cooldown counter incrementing).
      const perTurnBudget = chat.budget?.perTurn;
      const turnTokens = usage.tokensIn + usage.tokensOut;
      const perTurnTokensExceeded =
        perTurnBudget?.tokens !== undefined && turnTokens > perTurnBudget.tokens;
      const perTurnCostExceeded =
        perTurnBudget?.costUsd !== undefined && cost > perTurnBudget.costUsd;

      if (perTurnTokensExceeded || perTurnCostExceeded) {
        const capMessage = perTurnTokensExceeded
          ? `Per-turn token cap exceeded (${perTurnBudget?.tokens})`
          : `Per-turn cost cap exceeded (${perTurnBudget?.costUsd})`;
        guardState.lastBudgetOrGuardSignal = 'budget';
        if (saveToDb) {
          await sessionStore.appendTurn(
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
          await sessionStore.appendTurn(
            ctx,
            {
              sessionId: args.sessionId,
              ordinal: 0,
              role: 'assistant',
              content: '',
              inScope: false,
              sources: [],
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
        }
        await runBehavioralPostGuard(turnCtx, guardState);
        emit({
          type: 'notice',
          code: 'chat.budget_exceeded',
          message: capMessage,
        });
        emit({
          type: 'turn.failed',
          code: 'chat.budget_exceeded',
          message: capMessage,
        });
        emitter.end();
        return;
      }

      const streamedText = modelOutput.answer ?? '';
      emit({ type: 'message.delta', text: streamedText });

      guardState.modelOutput = modelOutput as unknown as Record<string, unknown>;
      if (toolCallingEnabled && guardState.modelOutput) {
        // Tools replace requestedAction in Path B; strip it so action-guard is a no-op.
        guardState.modelOutput.requestedAction = null;
      }
      trace?.recordModelOutput(guardState.modelOutput);

      // Persist only the sources the model actually cited (validated by the
      // provenance guard above), not every source we retrieved. The retrieved
      // set is debugging data; the cited set is the audit trail.
      const allowedHandles = guardState.resolvedSources ?? new Set<string>();
      const citedHandles: string[] = Array.isArray(guardState.modelOutput?.citedSources)
        ? (guardState.modelOutput.citedSources as string[]).filter((id) => allowedHandles.has(id))
        : [];
      const citedSourceRefs: ChatSourceRef[] = resolvedRaw.sourceRefs.filter((src) =>
        citedHandles.includes(src.id),
      );

      const onPostGuardBlock = async (
        verdict: Extract<GuardVerdict, { decision: 'block' }>,
        output: ChatTurnModelOutput,
      ): Promise<void> => {
        if (verdict.emit) emit(verdict.emit as ChatEvent);
        if (
          verdict.reason === 'provenance_missing' ||
          verdict.reason === 'provenance_insufficient' ||
          verdict.reason === 'action_budget_exceeded'
        ) {
          guardState.lastBudgetOrGuardSignal = 'budget';
        } else {
          guardState.lastBudgetOrGuardSignal = 'guardFailure';
        }
        if (verdict.reason === 'out_of_scope') {
          await ctx.events.emit(chatRefusalRecordedEvent.name, {
            chatName: chat.name,
            sessionId: args.sessionId,
            refusalReason:
              typeof output.refusalReason === 'string' ? output.refusalReason : 'off_topic',
          });
        }
      };

      for (const guard of postTurnGuards) {
        const verdict = await guard(turnCtx, guardState);
        trace?.recordGuard(guard.name || 'anonymous', verdict);
        if (verdict.decision === 'block') {
          await onPostGuardBlock(verdict, modelOutput);
        }
        if (verdict.decision === 'require_confirmation') {
          if (!saveToDb) {
            // Pending actions require DB durability (defineChat already rejects
            // saveToDb:false + allowedCapabilities). Defensive skip.
            emit({
              type: 'notice',
              code: 'chat.tool_arguments_invalid',
              message: 'Confirmation requires a durable session',
            });
          } else {
            const va = verdict.pendingAction;
            const binding = await resolveToolBinding(ctx, 'capability', va.capabilityName);
            const resumePayload: ChatToolResumePayloadV1 = {
              version: 1,
              chatName: chat.name,
              logicalTurnId: turnId,
              proposalAssistantTurnId: turnId,
              toolCallId: va.id,
              toolName: va.capabilityName,
              messages: [{ role: 'user', content: args.userMessage }],
              counters: {
                toolRoundsUsed: 0,
                flowStartsUsed: 0,
                flowAwaitMsUsed: 0,
                inputTokensUsed: usage.tokensIn,
                outputTokensUsed: usage.tokensOut,
                costUsed: cost,
              },
              toolsExecuted: [],
              sourceRefs: citedSourceRefs,
            };
            const built = buildNormalizedPending({
              ctx,
              sessionId: args.sessionId,
              expectedSessionRevision: session.revision ?? 0,
              capabilityName: va.capabilityName,
              rawInput: va.input,
              confirmationMessage: va.confirmationMessage,
              bindingInputSchemaHash: binding.ok ? binding.inputSchemaHash : undefined,
              toolBindingHash: binding.ok ? binding.toolBindingHash : undefined,
              ttlMs: 15 * 60 * 1000,
              resumePayload,
            });
            if (!built.ok) {
              // C3: no pending, no confirmation_required — one safe observation.
              emit({
                type: 'notice',
                code: built.code,
                message: 'Requested action could not be prepared',
              });
            } else {
              const store = resolveConversationStore();
              if (!store) {
                // Tier-1 store injected without the atomic tier: refuse rather
                // than commit a proposal that cannot be made atomic.
                emit({
                  type: 'notice',
                  code: 'chat.storage_unsupported',
                  message:
                    'Confirmations require a conversation store with atomic writes; none was injected',
                });
              } else {
                const leaseRes = await store.acquireSessionMutation({
                  sessionId: args.sessionId,
                  ownerToken: crypto.randomUUID(),
                  leaseMs: 30_000,
                });
                if (!leaseRes.acquired) {
                  emit({ type: 'notice', code: 'chat.session_busy', message: 'Session is busy' });
                } else {
                  try {
                    await store.commitProposal({
                      lease: leaseRes.lease,
                      expectedRevision: leaseRes.lease.sessionRevision,
                      userTurn: {
                        role: 'user',
                        content: args.userMessage,
                        inScope: true,
                        sources: [],
                        logicalTurnId: turnId,
                        tokensIn: 0,
                        tokensOut: 0,
                        costUsd: 0,
                        model: '',
                        latencyMs: 0,
                      },
                      assistantTurn: {
                        role: 'assistant',
                        content: built.pending.confirmationMessage,
                        inScope: modelOutput.inScope,
                        sources: citedSourceRefs,
                        logicalTurnId: turnId,
                        tokensIn: usage.tokensIn,
                        tokensOut: usage.tokensOut,
                        costUsd: cost,
                        model,
                        latencyMs: 0,
                        actionRequested: {
                          capabilityName: built.pending.capabilityName,
                          input: built.pending.input,
                        },
                      },
                      pending: {
                        ...built.pending,
                        expectedSessionRevision: leaseRes.lease.sessionRevision + 1,
                      },
                    });
                    emit({
                      type: 'confirmation_required',
                      actionId: built.pending.id,
                      capabilityName: built.pending.capabilityName,
                      confirmationMessage: built.pending.confirmationMessage,
                      expiresAt: built.pending.expiresAt,
                      schemaHash: built.pending.inputSchemaHash,
                      inputSchemaHash: built.pending.inputSchemaHash,
                      projection: built.pending.confirmationProjection,
                    });
                    proposalCommitted = true;
                  } finally {
                    await store.releaseSessionMutation({
                      sessionId: args.sessionId,
                      leaseToken: leaseRes.lease.leaseToken,
                    });
                  }
                }
              }
            }
          }
        }
      }

      // Scope coherence (Path B): the answer phase already passed the preflight
      // scope gate. If it contradicts with `off_topic`, coerce back to in-scope.
      // Only when a preflight actually ran: with `scopePreflight: false` the
      // answer's own `off_topic` is the only scope decision, so it stands
      // (coercing it left an empty, in-scope answer). NEVER coerce
      // `unsafe`/`pii_request` in either direction — honor those.
      const coherentScope = (output: ChatTurnModelOutput): ChatTurnModelOutput => {
        if (
          !(
            toolCallingEnabled &&
            scopePreflightEnabled &&
            scopeInScope === true &&
            output.refusalReason === 'off_topic'
          )
        ) {
          return output;
        }
        if (guardState.modelOutput) {
          guardState.modelOutput = {
            ...guardState.modelOutput,
            inScope: true,
            refusalReason: null,
          };
        }
        return { ...output, inScope: true, refusalReason: null };
      };
      modelOutput = coherentScope(modelOutput);

      if (proposalCommitted) {
        emitter.end();
        return;
      }

      const guardedAnswer =
        typeof guardState.modelOutput?.answer === 'string'
          ? guardState.modelOutput.answer
          : modelOutput.answer;

      // ── Regeneration (validateReply → `regenerate`) ──
      // Same prompt, same prompt input and history; the drafts and the app's
      // feedback follow as messages. Each call goes through ctx.ai (cost ledger,
      // caps) and is added to the turn's usage; the per-turn cap is re-checked.
      const regenThread: ChatMessage[] = [];
      let regenerationCalls = 0;
      const regenerate = async (
        feedback: string,
        draft: ChatFinalReply,
      ): Promise<ChatFinalReply> => {
        regenThread.push(
          { role: 'assistant', content: draftMessageOf(draft) },
          { role: 'user', content: feedback },
        );
        const costContext = {
          serviceArea: 'chat',
          operationName: `chat.${chat.name}.regenerate`,
        };
        regenerationCalls++;
        let data: unknown;
        let callUsage = { tokensIn: 0, tokensOut: 0 };
        let callCost = 0;
        let callModel: string | undefined;
        let callProvider: string | undefined;
        let output: ChatTurnModelOutput;
        if (agentThread) {
          const gen = await ctx.ai.generateWithUsage({
            prompt: promptName,
            input: userPayload,
            messages: [...agentThread, ...regenThread],
            outputValidation: 'prompt',
            validation: { maxRetries: 0 },
            ...toolAiOverrides(chat),
            signal: turnCtx.signal,
            costContext,
          });
          data = gen.data;
          callUsage = {
            tokensIn: gen.usage?.inputTokens ?? 0,
            tokensOut: gen.usage?.outputTokens ?? 0,
          };
          callCost = gen.cost ?? 0;
          callModel = gen.model;
          callProvider = gen.provider;
          opts?.onAgentOutput?.(data);
          output = {
            ...defaultModelOutput(),
            answer: chat.answerOf
              ? answerTextOf(chat, data)
              : String((data as { content?: unknown } | undefined)?.content ?? ''),
          };
        } else {
          const messages: ChatMessage[] = [
            ...threadMessages,
            { role: 'user', content: args.userMessage },
            ...regenThread,
          ];
          let done = false;
          try {
            for await (const chunk of ctx.ai.streamGenerate({
              prompt: promptName,
              input: userPayload,
              messages,
              signal: withTurnTimeout(
                turnCtx.signal,
                (chat.budget?.timeout?.perTurnSeconds ?? 120) * 1000,
              ),
              costContext,
            })) {
              if (chunk.type !== 'done') continue;
              done = true;
              data = chunk.data;
              if (chunk.usage) {
                callUsage = {
                  tokensIn: chunk.usage.inputTokens,
                  tokensOut: chunk.usage.outputTokens,
                };
              }
              callModel = chunk.model ?? undefined;
              callProvider = chunk.provider ?? undefined;
              if (chunk.cost != null) callCost = chunk.cost;
            }
          } catch {
            // Stream threw — fall through to the non-stream call, as for the first draft.
          }
          if (!done) {
            const gen = await ctx.ai.generateWithUsage({
              prompt: promptName,
              input: userPayload,
              messages,
              signal: turnCtx.signal,
              costContext,
            });
            data = gen.data;
            callUsage = {
              tokensIn: gen.usage?.inputTokens ?? 0,
              tokensOut: gen.usage?.outputTokens ?? 0,
            };
            callCost = gen.cost ?? 0;
            callModel = gen.model;
            callProvider = gen.provider;
          }
          output = chatModelOutputOf(chat, data ?? defaultModelOutput());
        }
        usage = {
          tokensIn: usage.tokensIn + callUsage.tokensIn,
          tokensOut: usage.tokensOut + callUsage.tokensOut,
        };
        cost += callCost;
        if (callModel) model = callModel;
        if (callProvider) provider = callProvider;
        const turnTokensNow = usage.tokensIn + usage.tokensOut;
        if (perTurnBudget?.tokens !== undefined && turnTokensNow > perTurnBudget.tokens) {
          throw new ChatRegenerationError(
            'chat.budget_exceeded',
            `Per-turn token cap exceeded (${perTurnBudget.tokens})`,
          );
        }
        if (perTurnBudget?.costUsd !== undefined && cost > perTurnBudget.costUsd) {
          throw new ChatRegenerationError(
            'chat.budget_exceeded',
            `Per-turn cost cap exceeded (${perTurnBudget.costUsd})`,
          );
        }

        // The post-turn guards check every draft. A regeneration rewrites the
        // reply; it never proposes an action, so `requestedAction` is cleared.
        guardState.modelOutput = {
          ...(output as unknown as Record<string, unknown>),
          requestedAction: null,
        };
        trace?.recordModelOutput(guardState.modelOutput);
        for (const guard of postTurnGuards) {
          const verdict = await guard(turnCtx, guardState);
          trace?.recordGuard(guard.name || 'anonymous', verdict);
          if (verdict.decision === 'block') await onPostGuardBlock(verdict, output);
        }
        output = coherentScope(output);
        const cited = Array.isArray(guardState.modelOutput?.citedSources)
          ? (guardState.modelOutput.citedSources as string[]).filter((id) => allowedHandles.has(id))
          : [];
        return {
          text:
            typeof guardState.modelOutput?.answer === 'string'
              ? guardState.modelOutput.answer
              : (output.answer ?? ''),
          inScope: output.inScope,
          refusalReason: output.refusalReason ?? null,
          sources: resolvedRaw.sourceRefs.filter((src) => cited.includes(src.id)),
          clientActions: normalizeClientActions(chat, clientActionsFromOutput(data), emit),
          modelOutput: data,
          toolsExecuted,
        };
      };

      // Validate before persist: the app's check runs on the finished reply, and
      // only the accepted or replacement text is written below.
      const finalized = await finalizeReply({
        ctx,
        chat,
        validateReply: opts?.validateReply,
        maxRegenerations: opts?.maxRegenerations,
        regenerate,
        shownText: streamedText,
        emit,
        reply: {
          text: guardedAnswer ?? '',
          inScope: modelOutput.inScope,
          refusalReason: modelOutput.refusalReason ?? null,
          sources: citedSourceRefs,
          clientActions: normalizeClientActions(
            chat,
            clientActionsFromOutput(structuredOutput),
            emit,
          ),
          modelOutput: structuredOutput,
          toolsExecuted,
        },
        turn: {
          ctx,
          chatName: chat.name,
          sessionId: args.sessionId,
          turnId,
          userId: session.userId,
          tenantId: session.tenantId,
          audience: args.audience,
          locale: args.locale,
          userMessage: args.userMessage,
          ...(args.promptInput ? { promptInput: args.promptInput } : {}),
          phase: 'turn',
        },
      });
      if (!finalized.ok) {
        // Fail closed: withdraw the streamed draft and persist nothing of the turn.
        emit({ type: 'message.replaced', text: '', code: 'chat.reply_validation_failed' });
        emit({
          type: 'turn.failed',
          code: 'chat.reply_validation_failed',
          message: 'The reply could not be checked',
        });
        emitter.end();
        return;
      }
      const finalAnswer = finalized.text;
      if (finalAnswer !== finalized.shownText) {
        emit({
          type: 'message.replaced',
          text: finalAnswer,
          code: finalized.moderation?.code ?? 'chat.reply_rewritten',
        });
      }
      const finalReply = finalized.reply;
      const clientActions = finalized.clientActions;

      // Ephemeral mode: no chat_session anchor row exists, so we can't FK
      // chat_turn rows to it. Cost still flows to onAICostRecorded via the AI
      // service's AICostContext (independent of this code path). Behavioral
      // state lives in clientHistory which the client re-sends each turn.
      if (saveToDb && !proposalCommitted) {
        await sessionStore.appendTurn(
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

        await sessionStore.appendTurn(
          ctx,
          {
            sessionId: args.sessionId,
            ordinal: 0,
            role: 'assistant',
            content: finalAnswer,
            inScope: finalReply.inScope,
            refusalReason: finalReply.refusalReason ?? undefined,
            sources: finalReply.sources,
            toolsExecuted: toolsExecuted.length > 0 ? toolsExecuted : undefined,
            ...(clientActions.length > 0 ? { clientActions } : {}),
            ...(finalized.moderation ? { moderation: finalized.moderation } : {}),
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
      }

      await ctx.events.emit(chatTurnCompletedEvent.name, {
        chatName: chat.name,
        sessionId: args.sessionId,
        turnId,
        costUsd: cost,
      });
      emit({
        type: 'turn.completed',
        turnId,
        usage,
        cost,
        model,
        provider,
        inScope: finalReply.inScope,
        refusalReason: finalReply.refusalReason ?? null,
        sources: finalReply.sources,
        ...(chat.clientActions ? { clientActions } : {}),
        ...(finalized.moderation ? { moderation: finalized.moderation } : {}),
        ...(regenerationCalls > 0 ? { regenerations: regenerationCalls } : {}),
      });
    } catch (err) {
      // Raw err.message can carry provider/database detail — log it, send a safe message.
      const message = clientSafeErrorMessage(ctx, err, 'turn');
      emit({ type: 'turn.failed', code: 'chat.turn_error', message });
    } finally {
      emitter.end();
    }
  })();

  yield* iterable;
}

export interface ResumeToolLoopArgs {
  chat: ChatDefinition;
  messages: ChatMessage[];
  counters: ChatToolResumePayloadV1['counters'];
  sourceRefs: ChatSourceRef[];
  toolsExecuted: ToolExecutionRecord[];
  logicalTurnId: string;
  emit: (evt: ChatEvent) => void;
  signal?: AbortSignal;
  /** Restored server-owned prompt fields for agent orchestration. */
  promptInput?: Record<string, unknown>;
  /**
   * A regeneration: the drafts and the app's feedback, appended to `messages`
   * for this call only. The call is tagged `chat.<name>.regenerate`.
   */
  regeneration?: ChatMessage[];
}

export type ResumeToolLoopResult =
  | {
      kind: 'answer';
      answer: string;
      inScope: boolean;
      refusalReason: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request' | null;
      model: string;
      provider: string;
      usage: { tokensIn: number; tokensOut: number };
      cost: number;
      sourceRefs: ChatSourceRef[];
      toolsExecuted: ToolExecutionRecord[];
      /** The continuation's validated output (for client actions / validateReply). */
      modelOutput?: unknown;
    }
  | {
      kind: 'failed';
      failure: ChatTurnFailedEvent;
    }
  | {
      kind: 'paused';
      newPending: ChatPendingActionV2;
      assistantTurn: ChatTurnWrite;
      confirmation: {
        actionId: string;
        capabilityName: string;
        confirmationMessage: string;
        expiresAt: string;
        inputSchemaHash: string;
        projection?: unknown;
      };
      sourceRefs: ChatSourceRef[];
      toolsExecuted: ToolExecutionRecord[];
    };

/**
 * Continuation driver after a confirmed tool: resume the bounded tool phase from
 * restored messages/counters, then run the answer phase. Mutates `counters` in place.
 */
export async function resumeToolLoop(
  ctx: ExecutionContext,
  args: ResumeToolLoopArgs,
): Promise<ResumeToolLoopResult> {
  const chat = args.chat;
  const promptName = chat.prompt?.name ?? chatTurnPrompt.name;
  const agentOrchestration = chat.policy?.toolCalling?.orchestration === 'agent';
  const compatibilityFailure = toolAiOverrideCompatibilityFailure(ctx, chat);
  if (compatibilityFailure) {
    return { kind: 'failed', failure: compatibilityFailure };
  }
  const gen = await ctx.ai.generateWithUsage({
    prompt: promptName,
    input:
      agentOrchestration && args.promptInput
        ? args.promptInput
        : { userMessage: 'Continue after tool execution' },
    messages: args.regeneration ? [...args.messages, ...args.regeneration] : args.messages,
    ...(agentOrchestration ? { outputValidation: 'none' as const } : {}),
    ...toolAiOverrides(chat),
    signal: args.signal,
    costContext: {
      serviceArea: 'chat',
      operationName: args.regeneration
        ? `chat.${chat.name}.regenerate`
        : `chat.${chat.name}.resume`,
    },
  });
  const modelOutput = agentOrchestration
    ? {
        ...defaultModelOutput(),
        answer: chat.answerOf ? answerTextOf(chat, gen.data) : String(gen.data?.content ?? ''),
      }
    : chatModelOutputOf(chat, gen.data);
  args.counters.inputTokensUsed += gen.usage?.inputTokens ?? 0;
  args.counters.outputTokensUsed += gen.usage?.outputTokens ?? 0;
  args.counters.costUsed += gen.cost ?? 0;
  return {
    kind: 'answer',
    answer: modelOutput.answer ?? '',
    inScope: modelOutput.inScope !== false,
    refusalReason: modelOutput.refusalReason ?? null,
    model: gen.model ?? 'unknown',
    provider: gen.provider ?? 'unknown',
    usage: {
      tokensIn: gen.usage?.inputTokens ?? 0,
      tokensOut: gen.usage?.outputTokens ?? 0,
    },
    cost: gen.cost ?? 0,
    sourceRefs: args.sourceRefs,
    toolsExecuted: args.toolsExecuted,
    modelOutput: gen.data,
  };
}
