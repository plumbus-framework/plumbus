'use client';

import type { ChatEvent } from '@plumbus/chat';
import { CHAT_CSRF_COOKIE_NAME, CHAT_CSRF_HEADER_NAME } from '@plumbus/chat';
import { useCallback, useRef, useState } from 'react';
import { readChatStream } from '../client/event-stream.js';
import {
  applyChatEvent,
  buildTurnRequestBody,
  initialChatUiState,
  pushUserMessage,
  type ChatUiMessage,
  type ChatUiPendingConfirmation,
  type ChatUiState,
} from './useChat-helpers.js';

export type { ChatUiMessage } from './useChat-helpers.js';

function readCsrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === CHAT_CSRF_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function useChat(args: {
  chatName: string;
  sessionId: string;
  audience: string;
  locale: string;
  persistence?: 'server' | 'client';
  turnUrl?: string;
  confirmUrl?: string;
}) {
  const [state, setState] = useState<ChatUiState>(initialChatUiState);
  // Mirror current pending so confirm()/decline() read the latest inputSchemaHash.
  const pendingRef = useRef<ChatUiPendingConfirmation | null>(state.pendingConfirmation);
  pendingRef.current = state.pendingConfirmation;

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

      const csrf = readCsrfCookie();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrf) headers[CHAT_CSRF_HEADER_NAME] = csrf;

      const res = await fetch(args.turnUrl ?? `/chat/${args.chatName}/turn`, {
        method: 'POST',
        headers,
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

  const postDecision = useCallback(
    async (decision: 'confirm' | 'reject', pc: ChatUiPendingConfirmation, actionId: string) => {
      if (!pc.inputSchemaHash) {
        // Server derives capability/input from storage but still requires the echoed
        // inputSchemaHash; without it the confirm cannot be issued.
        setState((prev) => ({ ...prev, status: 'error' }));
        return;
      }
      setState((prev) => ({ ...prev, status: 'streaming' }));

      const csrf = readCsrfCookie();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrf) headers[CHAT_CSRF_HEADER_NAME] = csrf;

      const res = await fetch(args.confirmUrl ?? `/chat/${args.chatName}/confirm`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ actionId, inputSchemaHash: pc.inputSchemaHash, decision }),
      });

      if (!res.ok) {
        setState((prev) => ({ ...prev, status: 'error', pendingConfirmation: null }));
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

  const confirm = useCallback(
    async (actionId?: string) => {
      const pc = pendingRef.current;
      if (!pc) return;
      await postDecision('confirm', pc, actionId ?? pc.actionId);
    },
    [postDecision],
  );

  const decline = useCallback(
    async (actionId?: string) => {
      const pc = pendingRef.current;
      if (!pc) return;
      await postDecision('reject', pc, actionId ?? pc.actionId);
    },
    [postDecision],
  );

  // Local dismiss without contacting the server (kept for back-compat).
  const cancel = useCallback(() => {
    setState((prev) => ({ ...prev, status: 'idle' }));
  }, []);

  return {
    messages: state.messages,
    status: state.status,
    notices: state.notices,
    pendingConfirmation: state.pendingConfirmation,
    lastConfirmResult: state.lastConfirmResult,
    send,
    confirm,
    decline,
    cancel,
  };
}
