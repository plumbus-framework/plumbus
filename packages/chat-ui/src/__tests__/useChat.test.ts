/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_CSRF_COOKIE_NAME, CHAT_CSRF_HEADER_NAME } from '@plumbus/chat';
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

  it('confirm POSTs {actionId,inputSchemaHash,decision:confirm} with credentials include', async () => {
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
      });
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({
        events: [
          {
            type: 'confirmation_required',
            actionId: 'a1',
            capabilityName: 'cap',
            confirmationMessage: 'go?',
            expiresAt: '2099-01-01T00:00:00Z',
            inputSchemaHash: 'hash-1',
          },
        ],
      }),
    });

    await act(async () => {
      root?.render(createElement(Host));
    });

    await act(async () => {
      await chat?.send('trigger confirm');
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({ events: [] }),
    });

    await act(async () => {
      await chat?.confirm('a1');
    });

    const confirmCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/confirm'),
    );
    expect(confirmCall?.[0]).toBe('/chat/help/confirm');
    expect(confirmCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
    });
    expect(JSON.parse(String(confirmCall?.[1]?.body))).toEqual({
      actionId: 'a1',
      inputSchemaHash: 'hash-1',
      decision: 'confirm',
    });
  });

  it('confirm sends the CSRF header when the cookie is present', async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: testing CSRF cookie echo in hook
    document.cookie = `${CHAT_CSRF_COOKIE_NAME}=csrf-token-value`;
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
      });
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({
        events: [
          {
            type: 'confirmation_required',
            actionId: 'a1',
            capabilityName: 'cap',
            confirmationMessage: 'go?',
            expiresAt: '2099-01-01T00:00:00Z',
            inputSchemaHash: 'hash-1',
          },
        ],
      }),
    });

    await act(async () => {
      root?.render(createElement(Host));
    });
    await act(async () => {
      await chat?.send('x');
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({ events: [] }),
    });

    await act(async () => {
      await chat?.confirm();
    });

    const confirmCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/confirm'),
    );
    expect(confirmCall?.[1]?.headers?.[CHAT_CSRF_HEADER_NAME]).toBe('csrf-token-value');
  });

  it('decline POSTs decision:reject', async () => {
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
      });
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({
        events: [
          {
            type: 'confirmation_required',
            actionId: 'a1',
            capabilityName: 'cap',
            confirmationMessage: 'go?',
            expiresAt: '2099-01-01T00:00:00Z',
            inputSchemaHash: 'hash-1',
          },
        ],
      }),
    });

    await act(async () => {
      root?.render(createElement(Host));
    });
    await act(async () => {
      await chat?.send('x');
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({ events: [] }),
    });

    await act(async () => {
      await chat?.decline();
    });

    const declineCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/confirm'),
    );
    expect(JSON.parse(String(declineCall?.[1]?.body))).toMatchObject({ decision: 'reject' });
  });

  it('confirm with a pending missing inputSchemaHash does not POST and sets status error', async () => {
    const fetchMock = vi.fn();
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

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({
        events: [
          {
            type: 'confirmation_required',
            actionId: 'a1',
            capabilityName: 'cap',
            confirmationMessage: 'go?',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        ],
      }),
    });

    await act(async () => {
      root?.render(createElement(Host));
    });
    await act(async () => {
      await chat?.send('x');
    });

    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      await chat?.confirm();
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(chat?.status).toBe('error');
  });
});
