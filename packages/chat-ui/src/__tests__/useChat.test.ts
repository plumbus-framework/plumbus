/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readChatStream } from '../client/event-stream.js';
import { useChat } from '../hooks/useChat.js';

describe('readChatStream', () => {
  it('parses SSE frames', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"message.delta","text":"Hi"}\n\ndata: {"type":"turn.completed","turnId":"1","usage":{"tokensIn":0,"tokensOut":0},"cost":0}\n\n',
          ),
        );
        controller.close();
      },
    });
    const res = new Response(body);
    const events = [];
    for await (const evt of readChatStream(res)) {
      events.push(evt);
    }
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe('message.delta');
  });
});

describe('useChat', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    root?.unmount();
    container?.remove();
    vi.unstubAllGlobals();
  });

  it('applies events from application/json turn responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({
        events: [
          { type: 'message.delta', text: 'Hello from JSON' },
          {
            type: 'turn.completed',
            turnId: 't1',
            usage: { tokensIn: 1, tokensOut: 2 },
            cost: 0,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    let chat: ReturnType<typeof useChat> | undefined;
    function Host() {
      chat = useChat({
        chatName: 'help',
        sessionId: 'sess-1',
        audience: 'user',
        locale: 'en',
      });
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Host));
    });

    await act(async () => {
      await chat?.send('hi');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/chat/help/turn',
      expect.objectContaining({ credentials: 'include', method: 'POST' }),
    );
    const assistant = chat?.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('Hello from JSON');
  });

  it('posts to the override turnUrl when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({ events: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    let chat: ReturnType<typeof useChat> | undefined;
    function Host() {
      chat = useChat({
        chatName: 'help',
        sessionId: 'sess-1',
        audience: 'user',
        locale: 'en',
        turnUrl: '/api/chat/help/turn',
      });
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Host));
    });

    await act(async () => {
      await chat?.send('hi');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/help/turn',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
