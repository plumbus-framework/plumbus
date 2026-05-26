'use client';

import type { ChatEvent } from '@plumbus/chat';
import { useCallback, useState } from 'react';
import { readChatStream } from '../client/event-stream.js';
import {
  applyChatEvent,
  buildTurnRequestBody,
  initialChatUiState,
  pushUserMessage,
  type ChatUiMessage,
  type ChatUiState,
} from './useChat-helpers.js';

export type { ChatUiMessage } from './useChat-helpers.js';

export function useChat(args: {
  chatName: string;
  sessionId: string;
  audience: string;
  locale: string;
  persistence?: 'server' | 'client';
  turnUrl?: string;
}) {
  const [state, setState] = useState<ChatUiState>(initialChatUiState);

  const send = useCallback(
    async (
      text: string,
      extras?: {
        sessionId?: string;
        locale?: string;
        extraBody?: Record<string, unknown>;
      },
    ) => {
      let snapshot: ChatUiMessage[] = [];
      setState((prev) => {
        snapshot = prev.messages;
        return pushUserMessage(prev, text);
      });

      const body = {
        ...buildTurnRequestBody({
          sessionId: extras?.sessionId ?? args.sessionId,
          userMessage: text,
          audience: args.audience,
          locale: extras?.locale ?? args.locale,
          persistence: args.persistence,
          currentMessages: snapshot,
        }),
        ...(extras?.extraBody ?? {}),
      };

      const res = await fetch(args.turnUrl ?? `/chat/${args.chatName}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        setState((prev) => ({ ...prev, status: 'error' }));
        return;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.startsWith('application/json')) {
        const payload = (await res.json()) as { events: ChatEvent[] };
        setState((prev) => {
          let next = prev;
          for (const evt of payload.events) {
            next = applyChatEvent(next, evt);
          }
          return next;
        });
        return;
      }

      for await (const evt of readChatStream(res)) {
        setState((prev) => applyChatEvent(prev, evt));
      }
    },
    [args],
  );

  const confirm = useCallback(async (_actionId: string) => {
    setState((prev) => ({ ...prev, pendingConfirmation: null, status: 'idle' }));
  }, []);

  const cancel = useCallback(() => {
    setState((prev) => ({ ...prev, status: 'idle' }));
  }, []);

  return {
    messages: state.messages,
    status: state.status,
    notices: state.notices,
    pendingConfirmation: state.pendingConfirmation,
    send,
    confirm,
    cancel,
  };
}
