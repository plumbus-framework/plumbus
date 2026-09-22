import type { ExecutionContext } from '@plumbus/core';
import { chatPendingActionRepo, chatTurnRepo } from '../internal/chat-repos.js';
import type { ChatBudget } from '../types/budget.js';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';
import {
  aggregateForBudget,
  appendTurn,
  createSession,
  getOrCreateSession,
  loadMergedUserBehavioralState,
  loadSession,
  updateSessionBehavioralState,
  updateSessionSummary,
} from './service.js';

export interface CreateChatSessionArgs {
  chatName: string;
  userId: string;
  audience: string;
  locale: string;
  tenantId?: string;
}

export interface GetOrCreateChatSessionArgs extends CreateChatSessionArgs {
  sessionId: string;
}

export interface ChatBudgetAggregateQuery {
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  since?: Date;
}

export interface ChatBudgetAggregate {
  turns: number;
  tokens: number;
  costUsd: number;
  userMessages: number;
}

/**
 * Tier 1 of the chat storage contract: the non-atomic session/turn surface that
 * `runChatTurn` needs to complete an ordinary turn.
 *
 * Every method takes `ctx` first so an adapter can reach the host application's
 * own subsystems — a remote memory platform is typically addressed through
 * `ctx.capabilities` / a port, not through `ctx.data`. Injecting a store that
 * implements this interface lets a deployment with **no local database** run the
 * stock turn pipeline instead of forking it:
 *
 * ```ts
 * runChatTurn(ctx, args, { sessionStore: myPortBackedStore })
 * ```
 *
 * Atomic multi-row work (tool confirmations, pending actions) lives in tier 2,
 * {@link ../runtime/chat-conversation-store.js#ChatConversationStore}, which is
 * optional — see `docs/chat/session-store.md`.
 *
 * ## Invariants an adapter must honor
 *
 * These are load-bearing for the rest of the pipeline; the DB-backed default
 * implements them and a replacement that does not will corrupt transcripts.
 *
 * - **`appendTurn` assigns the ordinal.** The caller passes `ordinal: 0` as a
 *   placeholder — the store MUST derive the real ordinal from the number of
 *   turns already stored for that session, so rows read back in ordinal order
 *   reproduce the conversation. It must also advance the session's `lastTurnAt`
 *   to the appended turn's `recordedAt`.
 * - **`appendTurn` honors `persistContent`.** When `false` (a chat configured
 *   with `persistence.messageContent: 'client'`), the row must be stored with an
 *   empty `content` string. Metadata — tokens, cost, model, sources — is still
 *   recorded. Storing the text anyway leaks message content the operator chose
 *   not to retain.
 * - **`getOrCreateSession` enforces ownership.** If a session exists under the
 *   requested id but belongs to a different `userId`, it MUST raise
 *   `ctx.errors.notFound` rather than returning the row — otherwise a guessed
 *   session id reads another user's conversation. Concurrent first turns racing
 *   the same id must converge on one row rather than creating two.
 * - **`listTurns` returns ascending ordinal order.** A `limit` truncates from the
 *   start of that ordering, matching the DB-backed history window.
 * - **`loadMergedUserBehavioralState` merges oldest → newest.** Later sessions
 *   win on key collision. Cooldowns declared with `scope: 'user'` are only
 *   enforceable across sessions if this reflects other sessions' state.
 */
export interface ChatSessionStore {
  /** Look up a session, inserting it with the caller-supplied identity on first turn. */
  getOrCreateSession(
    ctx: ExecutionContext,
    args: GetOrCreateChatSessionArgs,
  ): Promise<ChatSessionRow>;

  loadSession(ctx: ExecutionContext, sessionId: string): Promise<ChatSessionRow | null>;

  /** Append a turn. The store assigns the ordinal and advances `lastTurnAt`. */
  appendTurn(
    ctx: ExecutionContext,
    turn: Omit<ChatTurnRow, 'id'>,
    opts: { persistContent: boolean },
  ): Promise<ChatTurnRow>;

  /** Number of turns stored for the session — drives the emitted turn ordinal. */
  countTurns(ctx: ExecutionContext, sessionId: string): Promise<number>;

  /** Turns in ascending ordinal order; `limit` truncates from the start. */
  listTurns(
    ctx: ExecutionContext,
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<ChatTurnRow[]>;

  updateSessionBehavioralState(
    ctx: ExecutionContext,
    sessionId: string,
    behavioralState: Record<string, unknown>,
  ): Promise<void>;

  updateSessionSummary(
    ctx: ExecutionContext,
    sessionId: string,
    summaryText: string,
    summaryTurnCount: number,
  ): Promise<void>;

  /** Behavioral state merged across the user's recent sessions (oldest → newest). */
  loadMergedUserBehavioralState(
    ctx: ExecutionContext,
    userId: string,
    limit?: number,
  ): Promise<Record<string, unknown>>;

  /**
   * Cross-session spend/usage rollup. OPTIONAL: this is an analytics query rather
   * than session I/O, and a remote memory port may not be able to answer it. A
   * store that omits it can serve chats with no `budget` block; configuring one
   * fails closed with `chat.budget_unsupported` rather than silently letting a
   * cost cap go unenforced.
   */
  aggregateForBudget?(
    ctx: ExecutionContext,
    query: ChatBudgetAggregateQuery,
  ): Promise<ChatBudgetAggregate>;

  /**
   * Number of the session's pending actions that have not lapsed, used to enforce
   * `budget.actions.perSession`. Implementations are expected to retire rows whose
   * `expiresAt` has passed rather than count them.
   *
   * OPTIONAL, because pending actions belong to the atomic tier and a store with
   * no confirmation support has nothing to count. A chat that configures
   * `budget.actions.perSession` needs it — `assertChatStoresSupportChats` refuses
   * that combination at startup rather than letting the guard fall through to
   * `ctx.data`.
   */
  countActivePendingActions?(
    ctx: ExecutionContext,
    args: { sessionId: string; now: Date },
  ): Promise<number>;

  /**
   * Create a session with a store-generated id. OPTIONAL — `runChatTurn` never
   * calls it (it uses {@link ChatSessionStore.getOrCreateSession}); it exists for
   * applications that bootstrap sessions explicitly.
   */
  createSession?(ctx: ExecutionContext, args: CreateChatSessionArgs): Promise<ChatSessionRow>;
}

/**
 * The default tier-1 store: the `ctx.data.ChatSession` / `ctx.data.ChatTurn`
 * repositories. Used whenever no `sessionStore` is injected, so behavior for
 * existing applications is unchanged.
 */
export const dbChatSessionStore: ChatSessionStore = Object.freeze({
  // Delegating wrappers, not direct references: capturing the imported function
  // values here would freeze them at module-init time, so a test that spies on
  // `session/service.js` would no longer intercept calls made through the store.
  // Going through the live binding on each call keeps those seams working.
  getOrCreateSession: (ctx: ExecutionContext, args: GetOrCreateChatSessionArgs) =>
    getOrCreateSession(ctx, args),

  loadSession: (ctx: ExecutionContext, sessionId: string) => loadSession(ctx, sessionId),

  appendTurn: (
    ctx: ExecutionContext,
    turn: Omit<ChatTurnRow, 'id'>,
    opts: { persistContent: boolean },
  ) => appendTurn(ctx, turn, opts),

  updateSessionBehavioralState: (
    ctx: ExecutionContext,
    sessionId: string,
    behavioralState: Record<string, unknown>,
  ) => updateSessionBehavioralState(ctx, sessionId, behavioralState),

  updateSessionSummary: (
    ctx: ExecutionContext,
    sessionId: string,
    summaryText: string,
    summaryTurnCount: number,
  ) => updateSessionSummary(ctx, sessionId, summaryText, summaryTurnCount),

  loadMergedUserBehavioralState: (ctx: ExecutionContext, userId: string, limit?: number) =>
    loadMergedUserBehavioralState(ctx, userId, limit),

  aggregateForBudget: (ctx: ExecutionContext, query: ChatBudgetAggregateQuery) =>
    aggregateForBudget(ctx, query),

  createSession: (ctx: ExecutionContext, args: CreateChatSessionArgs) => createSession(ctx, args),

  async countTurns(ctx: ExecutionContext, sessionId: string): Promise<number> {
    const rows = await chatTurnRepo(ctx).findMany({ sessionId });
    return rows.length;
  },

  async listTurns(
    ctx: ExecutionContext,
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<ChatTurnRow[]> {
    return chatTurnRepo(ctx).findMany(
      { sessionId },
      { orderBy: 'ordinal', orderDir: 'asc', limit: opts?.limit },
    );
  },

  async countActivePendingActions(
    ctx: ExecutionContext,
    args: { sessionId: string; now: Date },
  ): Promise<number> {
    const repo = chatPendingActionRepo(ctx);
    const rows = await repo.findMany({ sessionId: args.sessionId, status: 'pending' });
    const now = args.now.getTime();
    let active = 0;
    for (const row of rows) {
      // Lazy expiry: a lapsed row is retired here rather than counted against the cap.
      if (new Date(row.expiresAt).getTime() <= now) {
        await repo.update(row.id, { status: 'expired' });
        continue;
      }
      active += 1;
    }
    return active;
  },
});

/** Narrow the optional injection down to a concrete store. */
export function resolveChatSessionStore(store?: ChatSessionStore): ChatSessionStore {
  return store ?? dbChatSessionStore;
}

export type ChatBudgetAggregator = (
  ctx: ExecutionContext,
  query: ChatBudgetAggregateQuery,
) => Promise<ChatBudgetAggregate>;

/**
 * Resolve the store's usage rollup, raising `chat.budget_unsupported` when the
 * store does not provide one. Silently skipping would leave a configured
 * per-user or per-tenant spend cap unenforced, so this fails closed instead.
 */
export function requireChatBudgetAggregator(
  ctx: ExecutionContext,
  args: { chatName: string; store: ChatSessionStore },
): ChatBudgetAggregator {
  const aggregate = args.store.aggregateForBudget;
  if (typeof aggregate !== 'function') {
    throw ctx.errors.internal(
      `Chat "${args.chatName}" declares a budget but the injected session store does not implement aggregateForBudget`,
      { code: 'chat.budget_unsupported', chatName: args.chatName },
    );
  }
  return aggregate.bind(args.store);
}

/**
 * Bootstrap check: fail fast when a chat declares budgets the injected store
 * cannot evaluate. Use from application bootstrap, where an `ExecutionContext` is
 * available; `assertChatStoresSupportChats` is the equivalent for route
 * registration, which runs before any context exists.
 */
export function assertChatSessionStoreSupportsBudget(
  ctx: ExecutionContext,
  args: { chatName: string; budget?: ChatBudget; store: ChatSessionStore },
): void {
  if (!args.budget) return;
  requireChatBudgetAggregator(ctx, { chatName: args.chatName, store: args.store });
}

export class ChatStoreUnsupportedError extends Error {
  readonly code: string;
  readonly chatName: string;
  constructor(code: string, chatName: string, message: string) {
    super(message);
    this.name = 'ChatStoreUnsupportedError';
    this.code = code;
    this.chatName = chatName;
  }
}

/** Minimal view of a chat definition needed to validate its storage requirements. */
interface ChatStorageRequirements {
  name: string;
  budget?: ChatBudget;
  policy?: {
    action?: { allowedCapabilities?: string[] };
    toolCalling?: { enabled: boolean };
  };
}

function describeMissingStoreMethod(chatName: string, method: string, reason: string): string {
  return `Chat "${chatName}" ${reason}, which requires the injected session store to implement ${method}`;
}

/**
 * Startup validation for injected storage, run before any turn is served.
 *
 * Only applies when a tier-1 `sessionStore` is injected — the DB-backed default
 * satisfies both tiers, so applications that inject nothing are unaffected. Two
 * mismatches are refused rather than discovered mid-conversation:
 *
 * - a chat declares a `budget` but the store cannot roll up usage, which would
 *   leave a spend cap unenforced;
 * - a chat caps pending actions per session but the store cannot count them,
 *   which would send the action guard back to `ctx.data`;
 * - a chat can raise confirmations (tool calling, or a Path A action policy) but
 *   no `conversationStore` provides the atomic commit path they require.
 */
export function assertChatStoresSupportChats(args: {
  chats: ChatStorageRequirements[];
  sessionStore?: ChatSessionStore;
  conversationStore?: unknown;
}): void {
  if (!args.sessionStore) return;

  for (const chat of args.chats) {
    if (chat.budget && typeof args.sessionStore.aggregateForBudget !== 'function') {
      throw new ChatStoreUnsupportedError(
        'chat.budget_unsupported',
        chat.name,
        describeMissingStoreMethod(chat.name, 'aggregateForBudget', 'declares a budget'),
      );
    }

    if (
      chat.budget?.actions?.perSession !== undefined &&
      typeof args.sessionStore.countActivePendingActions !== 'function'
    ) {
      throw new ChatStoreUnsupportedError(
        'chat.budget_unsupported',
        chat.name,
        describeMissingStoreMethod(
          chat.name,
          'countActivePendingActions',
          'caps pending actions per session',
        ),
      );
    }

    const usesConfirmations =
      chat.policy?.toolCalling?.enabled === true ||
      (chat.policy?.action?.allowedCapabilities?.length ?? 0) > 0;
    if (usesConfirmations && !args.conversationStore) {
      throw new ChatStoreUnsupportedError(
        'chat.storage_unsupported',
        chat.name,
        `Chat "${chat.name}" can request action confirmations, which need a conversation store with atomic writes; pass one alongside the injected session store`,
      );
    }
  }
}
