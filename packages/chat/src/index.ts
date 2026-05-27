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
export { buildSystemPrompt } from './prompt/build-system-prompt.js';
export { renderContext } from './prompt/render-context.js';

export { compilePolicy } from './policy/registry.js';
export { runChatTurn } from './runtime/run-turn.js';
export { registerChatRoutes, type RegisterChatRoutesOpts } from './runtime/http.js';
export { ChatEventEmitter } from './runtime/events.js';
export { validateCitations, stripInvalidFromAnswer } from './runtime/provenance.js';
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
  chatRefusalRecordedEvent,
} from './events/chat-events.js';
