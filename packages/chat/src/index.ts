export * from './types/index.js';
export { defineChat } from './define/defineChat.js';

export { chatSessionEntity } from './session/entity.js';
export { chatTurnEntity } from './session/turn-entity.js';
export { chatPendingActionEntity } from './session/pending-action-entity.js';

export {
  createSession,
  loadSession,
  appendTurn,
  aggregateForBudget,
  updateSessionBehavioralState,
  updateSessionSummary,
} from './session/service.js';

export { knowledgeContext, CHAT_TIER_TOOLS_ERROR_PREFIX } from './context/knowledge-context.js';
export { ragContext } from './context/rag-context.js';
/**
 * @deprecated Use `ragContext` for direct RAG access, or `knowledgeContext` with a registry.
 * Removal target: `@plumbus/chat` v0.2.
 */
export { ragContext as knowledgeContextLegacy } from './context/rag-context.js';
export { capabilityContext } from './context/capability-context.js';
export { staticContext } from './context/static-context.js';
export { staticContextFromTranslations } from './context/static-context-from-translations.js';
export { resolveContextSources } from './context/resolver.js';

export { chatTurnPrompt } from './prompt/chat-turn.prompt.js';
export { chatSummarizeHistoryPrompt } from './prompt/chat-summarize-history.prompt.js';
export { chatToolRoundPrompt } from './prompt/chat-tool-round.prompt.js';
export { chatScopeCheckPrompt } from './prompt/chat-scope-check.prompt.js';
export { buildSystemPrompt } from './prompt/build-system-prompt.js';
export { renderContext } from './prompt/render-context.js';

export { compilePolicy } from './policy/registry.js';
export { runChatTurn } from './runtime/run-turn.js';
export {
  registerChatRoutes,
  type RegisterChatRoutesOpts,
  type ChatHttpOptions,
  type ChatRequestAuthentication,
  type ChatRequestAuthenticator,
} from './runtime/http.js';
export {
  type ChatConversationStore,
  type ChatTurnWrite,
  type SessionMutationLease,
  type AcquireSessionMutationResult,
  type ClaimPendingResult,
  createChatConversationStore,
  assertChatStorageSupported,
} from './runtime/chat-conversation-store.js';
export type { ChatPendingActionV2, ChatToolResumePayloadV1 } from './session/pending-action-v2.js';
export {
  bindChatCapabilityTools,
  ChatToolBindError,
  type BoundChatTool,
  type BoundToolKind,
  type BoundToolMode,
  type ChatToolAnnotations,
  type ChatToolPresentation,
} from './runtime/bind-tools.js';
export { isConfirmCapability } from './runtime/tool-effects.js';
export { runToolPhase, type RunToolPhaseArgs, type ToolPhaseResult } from './runtime/tool-phase.js';
export { createChatRegistry, type ChatRegistry } from './runtime/chat-registry.js';
export { ChatEventEmitter } from './runtime/events.js';
export { validateCitations, stripInvalidFromAnswer } from './runtime/provenance.js';
export { resumeAfterConfirm, type ChatConfirmResult } from './runtime/resume-after-confirm.js';
export {
  CHAT_CSRF_COOKIE_NAME,
  CHAT_CSRF_HEADER_NAME,
  csrfBindingFromAuth,
  issueCsrfToken,
  verifyCsrfToken,
  normalizeOrigin,
  originAllowed,
} from './runtime/csrf.js';
export { setTokenCounter } from './budget/context-budget.js';

export { createChatTurnCapability } from './capabilities/chat-turn.js';
export { chatConfirmAction } from './capabilities/chat-confirm-action.js';
export { chatListTurns } from './capabilities/chat-list-turns.js';

export { defineChatEvaluation } from './define/defineChatEvaluation.js';
export { runChatEvaluation } from './eval/run-evaluation.js';
export { TraceRecorder } from './eval/trace.js';
export {
  chatTurnCompletedEvent,
  chatActionConfirmedEvent,
  chatActionRejectedEvent,
  chatRefusalRecordedEvent,
} from './events/chat-events.js';
