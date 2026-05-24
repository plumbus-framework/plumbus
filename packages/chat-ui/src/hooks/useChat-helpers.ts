import type { ChatEvent } from '@plumbus/chat';

export type ChatUiStatus = 'idle' | 'streaming' | 'awaiting_confirmation' | 'cooldown' | 'error';

export type ChatUiMessage = {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
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
        },
      };

    case 'turn.completed':
      return { ...state, status: 'idle' };

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

export interface TurnRequestBody {
  sessionId: string;
  userMessage: string;
  audience: string;
  locale: string;
  clientHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Builds the POST body for `/chat/:name/turn`.
 *
 * In `client` persistence mode the body carries the last 20 messages plus the
 * about-to-send user message as `clientHistory` — the server has no message
 * content of its own and uses this to give the model conversational context
 * (Decision 0009). In `server` mode `clientHistory` is omitted; the server
 * hydrates history from `ChatTurn` rows.
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
    const all: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...args.currentMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: args.userMessage },
    ];
    body.clientHistory = all.slice(-20);
  }
  return body;
}
