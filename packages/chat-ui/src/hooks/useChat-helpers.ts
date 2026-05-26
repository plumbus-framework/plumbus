import type { ChatEvent } from '@plumbus/chat';

export type ChatUiStatus = 'idle' | 'streaming' | 'awaiting_confirmation' | 'cooldown' | 'error';

export type ChatUiMessage = {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  inScope?: boolean;
  refusalReason?: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request' | null;
};

export type ChatUiNotice = {
  code: string;
  message: string;
  retryAfterSeconds?: number;
};

export type ChatUiPendingConfirmation = {
  actionId: string;
  capabilityName: string;
  confirmationMessage: string;
  expiresAt: string;
  /** Echo this back to `chatConfirmAction` so the server can detect schema
   * drift between propose and confirm. May be missing when talking to a
   * pre-0.1.4 server — apps that wire confirmation should treat that as a
   * configuration error. */
  schemaHash?: string;
};

export interface ChatUiState {
  messages: ChatUiMessage[];
  status: ChatUiStatus;
  notices: ChatUiNotice[];
  pendingConfirmation: ChatUiPendingConfirmation | null;
}

export const initialChatUiState: ChatUiState = {
  messages: [],
  status: 'idle',
  notices: [],
  pendingConfirmation: null,
};

/**
 * Pure event-to-state reducer. Used by `useChat` to fold the SSE event stream
 * into UI state. Pulled out of the hook so the state-transition logic is
 * testable without rendering React.
 */
export function applyChatEvent(state: ChatUiState, evt: ChatEvent): ChatUiState {
  switch (evt.type) {
    case 'turn.started':
      return { ...state, status: 'streaming' };

    case 'message.delta': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: last.content + evt.text };
      } else {
        messages.push({ role: 'assistant', content: evt.text });
      }
      return { ...state, messages };
    }

    case 'source.added': {
      // Attach cited source ids to the assistant message currently being
      // streamed. We dedupe; the model may name the same source repeatedly.
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        const sources = new Set([...(last.sources ?? []), evt.source.id]);
        messages[messages.length - 1] = { ...last, sources: [...sources] };
      }
      return { ...state, messages };
    }

    case 'notice':
      return {
        ...state,
        notices: [
          ...state.notices,
          { code: evt.code, message: evt.message, retryAfterSeconds: evt.retryAfterSeconds },
        ],
        status: evt.code === 'chat.cooldown_active' ? 'cooldown' : state.status,
      };

    case 'confirmation_required':
      return {
        ...state,
        status: 'awaiting_confirmation',
        pendingConfirmation: {
          actionId: evt.actionId,
          capabilityName: evt.capabilityName,
          confirmationMessage: evt.confirmationMessage,
          expiresAt: evt.expiresAt,
          schemaHash: evt.schemaHash,
        },
      };

    case 'turn.completed': {
      const messages = [...state.messages];
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (last?.role === 'assistant') {
        messages[lastIdx] = {
          ...last,
          inScope: evt.inScope,
          refusalReason: evt.refusalReason ?? null,
        };
      }
      return { ...state, messages, status: 'idle' };
    }

    case 'turn.failed':
      return { ...state, status: 'error' };

    default:
      return state;
  }
}

/**
 * Appends a user message to local state. Used by `send()` before kicking off
 * the SSE request so the user sees their message immediately.
 */
export function pushUserMessage(state: ChatUiState, text: string): ChatUiState {
  return {
    ...state,
    messages: [...state.messages, { role: 'user', content: text }],
    status: 'streaming',
  };
}

export interface BuildTurnBodyArgs {
  sessionId: string;
  userMessage: string;
  audience: string;
  locale: string;
  persistence?: 'server' | 'client';
  currentMessages: ChatUiMessage[];
}

export type WireRefusalReason = 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request';

export interface WireHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Set on past assistant turns that were refusals. Used by the server's
   * behavioral cooldown guard when the chat runs with `saveToDb: false`
   * (cooldowns are enforced from clientHistory instead of from chat_session
   * state). Optional + nullable so legacy clients still parse. */
  refusalReason?: WireRefusalReason | null;
}

export interface TurnRequestBody {
  sessionId: string;
  userMessage: string;
  audience: string;
  locale: string;
  clientHistory?: WireHistoryMessage[];
}

/**
 * Builds the POST body for `/chat/:name/turn`.
 *
 * In `client` persistence mode the body carries the last 20 messages plus the
 * about-to-send user message as `clientHistory` — the server has no message
 * content of its own and uses this to give the model conversational context
 * (Decision 0009). Assistant messages also carry their `refusalReason` when
 * applicable so server-side behavioral cooldowns can run without DB state
 * (`defineChat({ persistence: { saveToDb: false } })`). In `server` mode
 * `clientHistory` is omitted; the server hydrates history from `ChatTurn` rows.
 *
 * The 20-message cap mirrors the server's `CLIENT_HISTORY_MAX_MESSAGES`. The
 * hook caps proactively so a long-lived conversation doesn't grow the request
 * past the server's reject threshold.
 */
export function buildTurnRequestBody(args: BuildTurnBodyArgs): TurnRequestBody {
  const body: TurnRequestBody = {
    sessionId: args.sessionId,
    userMessage: args.userMessage,
    audience: args.audience,
    locale: args.locale,
  };
  if (args.persistence === 'client') {
    const all: WireHistoryMessage[] = [
      ...args.currentMessages.map((m): WireHistoryMessage => {
        const wire: WireHistoryMessage = { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.refusalReason) {
          wire.refusalReason = m.refusalReason;
        }
        return wire;
      }),
      { role: 'user', content: args.userMessage },
    ];
    body.clientHistory = all.slice(-20);
  }
  return body;
}
