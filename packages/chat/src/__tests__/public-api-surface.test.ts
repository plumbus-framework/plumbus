import { describe, expect, it } from 'vitest';
import * as evalEntry from '../eval/index.js';
import * as index from '../index.js';
import * as protocol from '../protocol.js';
import * as session from '../session.js';
import * as testing from '../testing/index.js';

/**
 * Runtime export surface of every `@plumbus/chat` entry point. A change here is
 * a public API change: update the CHANGELOG and docs with it.
 */
const EXPECTED_INDEX_EXPORTS = [
  'CHAT_CSRF_COOKIE_NAME',
  'CHAT_CSRF_HEADER_NAME',
  'CHAT_TIER_TOOLS_ERROR_PREFIX',
  'ChatEventEmitter',
  'ChatLegacyReasoningEffortValues',
  'ChatReasoningLevelValues',
  'ChatStoreUnsupportedError',
  'ChatToolBindError',
  'TraceRecorder',
  'aggregateForBudget',
  'appendTurn',
  'assertChatSessionStoreSupportsBudget',
  'assertChatStorageSupported',
  'assertChatStoresSupportChats',
  'bindChatCapabilityTools',
  'buildSystemPrompt',
  'capabilityContext',
  'chatActionConfirmedEvent',
  'chatActionRejectedEvent',
  'chatConfirmAction',
  'chatListTurns',
  'chatPendingActionEntity',
  'chatRefusalRecordedEvent',
  'chatScopeCheckPrompt',
  'chatSessionEntity',
  'chatSummarizeHistoryPrompt',
  'chatToolRoundPrompt',
  'chatTurnCompletedEvent',
  'chatTurnEntity',
  'chatTurnPrompt',
  'chatTurnWithReplyMetadataEntity',
  'compilePolicy',
  'createChatConversationStore',
  'createChatRegistry',
  'createChatTurnCapability',
  'createSession',
  'csrfBindingFromAuth',
  'dbChatSessionStore',
  'defineChat',
  'defineChatEvaluation',
  'isConfirmCapability',
  'issueCsrfToken',
  'knowledgeContext',
  'knowledgeContextLegacy',
  'loadSession',
  'normalizeOrigin',
  'originAllowed',
  'promptJudge',
  'promptUserSimulator',
  'ragContext',
  'registerChatRoutes',
  'renderContext',
  'requireChatBudgetAggregator',
  'resolveChatSessionStore',
  'resolveContextSources',
  'resumeAfterConfirm',
  'runChatEvaluation',
  'runChatTurn',
  'runToolPhase',
  'setTokenCounter',
  'staticContext',
  'staticContextFromTranslations',
  'stripInvalidFromAnswer',
  'updateSessionBehavioralState',
  'updateSessionSummary',
  'validateCitations',
  'verifyCsrfToken',
];

const EXPECTED_EVAL_EXPORTS = [
  'TraceRecorder',
  'checkAssertion',
  'defineChatEvaluation',
  'promptJudge',
  'promptUserSimulator',
  'runChatEvaluation',
];

const EXPECTED_TESTING_EXPORTS = [
  'createInMemoryChatConversationStore',
  'createInMemoryChatSessionStore',
  'mockChatRuntime',
];

const EXPECTED_PROTOCOL_EXPORTS = ['CHAT_CSRF_COOKIE_NAME', 'CHAT_CSRF_HEADER_NAME'];

const EXPECTED_SESSION_EXPORTS = [
  'ChatLegacyReasoningEffortValues',
  'ChatReasoningLevelValues',
  'chatActionConfirmedEvent',
  'chatActionRejectedEvent',
  'chatPendingActionEntity',
  'chatRefusalRecordedEvent',
  'chatSessionEntity',
  'chatTurnCompletedEvent',
  'chatTurnEntity',
  'chatTurnWithReplyMetadataEntity',
  'defineChat',
  'runChatTurn',
];

describe('@plumbus/chat public API surface', () => {
  it('root entry', () => {
    expect(Object.keys(index).sort()).toEqual([...EXPECTED_INDEX_EXPORTS].sort());
  });
  it('./eval', () => {
    expect(Object.keys(evalEntry).sort()).toEqual([...EXPECTED_EVAL_EXPORTS].sort());
  });
  it('./testing', () => {
    expect(Object.keys(testing).sort()).toEqual([...EXPECTED_TESTING_EXPORTS].sort());
  });
  it('./protocol', () => {
    expect(Object.keys(protocol).sort()).toEqual([...EXPECTED_PROTOCOL_EXPORTS].sort());
  });
  it('./session', () => {
    expect(Object.keys(session).sort()).toEqual([...EXPECTED_SESSION_EXPORTS].sort());
  });
});
