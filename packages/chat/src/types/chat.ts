import type { AccessPolicy } from '@plumbus/core';
import type { PromptDefinition } from '@plumbus/core';
import type { z } from '@plumbus/core/zod';
import type { ChatBudget } from './budget.js';
import type { ContextSource } from './context.js';
import type { ChatPolicy } from './policy.js';

export type ChatExposeAs = 'capability' | 'sse' | 'both';

export type MessagePersistence = 'server' | 'client';

export interface ChatHistorySummarizeConfig {
  strategy: 'rolling' | 'threshold';
  /** Summarize once more than this many turns are not yet in the summary. Without it the summarizer never runs. */
  thresholdTurns?: number;
  targetTokens?: number;
  /**
   * Language of the summary. `'conversation'` (default): the chat's
   * `policy.reply.locale` when it names one, else the session's locale. Any other
   * value is a BCP 47 tag used as is. An unusable tag falls back to "the
   * language the conversation is conducted in".
   */
  locale?: 'conversation' | string;
}

export interface ChatHistoryConfig {
  includeLastTurns?: number;
  /** Rolling summary of older turns. Off unless set with `thresholdTurns`; `false` turns it off explicitly. */
  summarize?: ChatHistorySummarizeConfig | false;
}

/**
 * Structured, app-defined UI moves a reply may carry ("open this lesson",
 * "show the hint"): the page carries them out, with no extra model call and no
 * server capability. Distinct from server `actions` / tool calling, which run
 * capabilities (with confirmation).
 *
 * The runtime reads them from the prompt output's `clientActions` array, drops
 * those that fail `schema`, keeps at most `maxPerReply`, sends them on
 * `turn.completed.clientActions` and persists them with the assistant turn.
 */
export interface ChatClientActionsConfig {
  /** Schema of ONE client action. */
  schema: z.ZodTypeAny;
  /** Default 1; range 1..10. */
  maxPerReply?: number;
}

export interface ChatConfig {
  name: string;
  description?: string;
  access: AccessPolicy;
  context?: ContextSource[];
  actions?: string[];
  policy?: ChatPolicy;
  budget?: ChatBudget;
  history?: ChatHistoryConfig;
  instructions?: string[];
  prompt?: PromptDefinition<z.ZodTypeAny, z.ZodTypeAny>;
  /** Opt-in client actions; see {@link ChatClientActionsConfig}. */
  clientActions?: ChatClientActionsConfig;
  /**
   * `messageContent` controls where turn TEXT lives:
   *   - `'server'`: `chat_turn.content` is written by the runtime (default).
   *   - `'client'`: `chat_turn.content` is left empty; the browser owns the prose
   *     and re-sends prior messages via `clientHistory` each turn.
   *
   * `saveToDb` controls whether the runtime touches the chat tables AT ALL:
   *   - `true` (default): `chat_session` + `chat_turn` rows are written;
   *     cooldowns + per-session/per-user/per-tenant budgets + pending actions
   *     + audit trail all work. Server-authoritative state.
   *   - `false`: no chat-table writes. Sessions are ephemeral (client owns
   *     `sessionId` generation); the runtime skips `loadSession`,
   *     `appendTurn`, `aggregateTurnCount`, `checkBudgetPreflight`,
   *     and `maybeSummarize`. Cooldowns + per-session message-cap budgets are
   *     enforced from `clientHistory` instead (refusalReason now travels on
   *     each history message — see ChatEvent for the wire shape). Useful for
   *     in-product help widgets and any chat surface where DB durability is
   *     overkill. Cost recording via `onAICostRecorded` is unaffected — costs
   *     still flow through the AI service's `AICostContext`.
   *
   * `saveToDb: false` requires `messageContent: 'client'` (validated by
   * `defineChat`): without a turn row there's nowhere to put server-side
   * content. Also rejects `policy.action.allowedCapabilities` (pending actions
   * can't survive across requests without DB).
   */
  persistence?: {
    messageContent: MessagePersistence;
    saveToDb?: boolean;
  };
  exposeAs?: ChatExposeAs;
  /**
   * When false, registerChatRoutes registers a JSON request/response route
   * instead of SSE. Defaults to true (SSE).
   */
  streaming?: boolean;
  /** Per-source context resolution timeout (default 5000ms). */
  contextResolution?: {
    perSourceTimeoutMs?: number;
  };
}

export interface ChatDefinition extends ChatConfig {
  kind: 'chat';
}
