import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  isProviderAPIError,
  ProviderAPIError,
  type ProviderStreamEvent,
} from '../provider.js';
import { AIInvalidRequestError } from '../refusal.js';

// A fake provider on loopback: each test sets how it answers (or stalls).
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = () => undefined;
let server: Server;
let baseUrl = '';
const answers = new Set<ServerResponse>();

beforeAll(async () => {
  server = createServer((req, res) => {
    answers.add(res);
    // Drain the request body so the client's write completes before the handler stalls.
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  // Initialize Node's lazy undici dispatcher even when just one dispatcher test is selected.
  await (await fetch('data:,initialize-dispatcher')).text();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Every abort below must reach the caller as a rejection or an error event, never unhandled.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  // Let aborted sockets and timers settle so a late rejection would be seen.
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off('unhandledRejection', onUnhandled);
  // Drop what the fake provider still holds open. Only those answers: undici keeps an idle
  // connection ready, and closing it under the pool would fail the next test's request.
  for (const res of answers) if (!res.writableEnded) res.destroy();
  answers.clear();
  vi.unstubAllGlobals();
  expect(unhandled).toEqual([]);
});

const stall: Handler = () => undefined;

const DISPATCHER_V1 = Symbol.for('undici.globalDispatcher.1');
const DISPATCHER_V2 = Symbol.for('undici.globalDispatcher.2');
const dispatcherGlobals = globalThis as unknown as Record<symbol, unknown>;
type Dispatcher = {
  dispatch(options: Record<string, unknown>, handler: unknown): boolean;
  close(): Promise<void>;
};

function activeDispatcher(): { key: symbol; dispatcher: Dispatcher } {
  const key = dispatcherGlobals[DISPATCHER_V2] ? DISPATCHER_V2 : DISPATCHER_V1;
  return { key, dispatcher: dispatcherGlobals[key] as Dispatcher };
}

function preserveDispatchers(): () => void {
  const originals = [DISPATCHER_V1, DISPATCHER_V2].map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  }));
  return () => {
    for (const { key, descriptor } of originals) {
      if (descriptor) {
        // Node 24 defines both slots as non-configurable but writable. Restore their values
        // and attributes; only a slot absent before the test may be deleted.
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete dispatcherGlobals[key];
      }
    }
    for (const { key, descriptor } of originals) {
      expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
    }
  };
}

function openAIChatAnswer(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
}

function expectTimeout(error: unknown, providerName: string, timeoutMs: number): void {
  expect(error).toBeInstanceOf(ProviderAPIError);
  expect(isProviderAPIError(error)).toBe(true);
  const failure = error as ProviderAPIError;
  expect(failure.providerName).toBe(providerName);
  expect(failure.timeoutMs).toBe(timeoutMs);
  expect(failure.retryable).toBe(false);
  expect(failure.statusCode).toBeUndefined();
  expect(failure.attempts).toBe(1);
  expect(failure.message).toMatch(new RegExp(`timed out after ${timeoutMs} ms$`));
  expect((failure.cause as Error).name).toBe('TimeoutError');
}

describe('provider request timeouts', () => {
  it('ends a stalled OpenAI call at the request timeout, not the adapter default', async () => {
    handler = stall;
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const startedAt = Date.now();
    const error = await rejectionOf(adapter.complete({ prompt: 'long', timeout: 300 }));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expectTimeout(error, 'openai', 300);
  });

  it('lets a request outlast a shorter adapter requestTimeout', async () => {
    handler = (_req, res) => setTimeout(() => openAIChatAnswer(res), 600);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl, requestTimeout: 200 });
    const result = await adapter.complete({ prompt: 'slow', timeout: 5_000 });
    expect(result.content).toBe('ok');
  });

  it('covers reading the answer body, not only the wait for headers', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
    };
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    expectTimeout(
      await rejectionOf(adapter.complete({ prompt: 'x', timeout: 300 })),
      'openai',
      300,
    );
  });

  it("rethrows the caller's own abort as raised, not as a timeout", async () => {
    handler = stall;
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 50);
    const error = await rejectionOf(
      adapter.complete({ prompt: 'x', timeout: 5_000, signal: caller.signal }),
    );
    expect(error).not.toBeInstanceOf(ProviderAPIError);
    expect((error as Error).name).toBe('AbortError');
  });

  it('applies to the OpenAI Responses API path (GPT-6 tools)', async () => {
    handler = stall;
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const error = await rejectionOf(
      adapter.complete({
        prompt: 'x',
        model: 'gpt-6-luna',
        tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
        timeout: 300,
      }),
    );
    expectTimeout(error, 'openai', 300);
    expect((error as Error).message).toMatch(/^OpenAI Responses API request timed out/);
  });

  it('applies to Anthropic', async () => {
    handler = stall;
    const adapter = createAnthropicAdapter({ apiKey: 'ant-test', baseUrl });
    expectTimeout(
      await rejectionOf(adapter.complete({ prompt: 'x', timeout: 300 })),
      'anthropic',
      300,
    );
  });

  it('covers a whole OpenAI stream: a stalled stream fails as the timeout after its deltas', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    };
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const events: ProviderStreamEvent[] = [];
    const error = await rejectionOf(
      (async () => {
        for await (const event of adapter.stream({ prompt: 'x', timeout: 400 })) events.push(event);
      })(),
    );
    expect(events).toEqual([{ type: 'content_delta', delta: 'Hel' }]);
    expectTimeout(error, 'openai', 400);
  });

  it('reports a stream that never started as an error event carrying the timeout', async () => {
    handler = stall;
    for (const adapter of [
      createOpenAIAdapter({ apiKey: 'sk-test', baseUrl }),
      createAnthropicAdapter({ apiKey: 'ant-test', baseUrl }),
    ]) {
      const events: ProviderStreamEvent[] = [];
      for await (const event of adapter.stream({ prompt: 'x', timeout: 300 })) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('error');
      expect(events[0]?.error).toMatch(/timed out after 300 ms$/);
      expectTimeout(events[0]?.cause, adapter.name, 300);
    }
  });

  it('covers a whole Anthropic stream', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      );
    };
    const adapter = createAnthropicAdapter({ apiKey: 'ant-test', baseUrl });
    const events: ProviderStreamEvent[] = [];
    const error = await rejectionOf(
      (async () => {
        for await (const event of adapter.stream({ prompt: 'x', timeout: 400 })) events.push(event);
      })(),
    );
    expect(events).toEqual([{ type: 'content_delta', delta: 'Hel' }]);
    expectTimeout(error, 'anthropic', 400);
  });

  it.each([
    0,
    -5,
    1.5,
    Number.NaN,
    2 ** 31,
  ])('refuses timeout %s before sending anything', async (timeout) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const error = await rejectionOf(adapter.complete({ prompt: 'x', timeout }));
    expect(error).toBeInstanceOf(AIInvalidRequestError);
    expect((error as AIInvalidRequestError).reason).toBe('timeout_invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Node fetch's own header and body limits", () => {
  // Node's fetch (undici) stops waiting after 300 s without headers or without a body chunk.
  // These tests install a global dispatcher with those limits at 250 ms (undici's timers fire
  // about a second late at that size) and a provider that takes two seconds, standing in for a
  // 300 s limit and a longer answer.
  let restoreDispatchers: (() => void) | undefined;
  let lowLimits: Dispatcher | undefined;
  const dispatched: Record<string, unknown>[] = [];

  beforeEach(() => {
    restoreDispatchers = preserveDispatchers();
    const { key, dispatcher } = activeDispatcher();
    const Agent = (dispatcher as unknown as { constructor: new (options: object) => Dispatcher })
      .constructor;
    lowLimits = new Agent({ headersTimeout: 250, bodyTimeout: 250 });
    const dispatch = lowLimits.dispatch.bind(lowLimits);
    dispatched.length = 0;
    lowLimits.dispatch = (options, dispatchHandler) => {
      dispatched.push(options);
      return dispatch(options, dispatchHandler);
    };
    dispatcherGlobals[key] = lowLimits;
  });

  afterEach(async () => {
    try {
      restoreDispatchers?.();
    } finally {
      await lowLimits?.close();
      lowLimits = undefined;
    }
  });

  it('do not cut a non-streamed answer that the request timeout still allows', async () => {
    handler = (_req, res) => setTimeout(() => openAIChatAnswer(res), 2_000);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const result = await adapter.complete({ prompt: 'long answer', timeout: 10_000 });
    expect(result.content).toBe('ok');
    // The application's own dispatcher carried the request, its limits raised just above the
    // timeout (one second), so the request's own timer always ends it first.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ headersTimeout: 11_000, bodyTimeout: 11_000 });
  }, 15_000);

  it('do not cut a stream whose next chunk the request timeout still allows', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      setTimeout(() => {
        res.end('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
      }, 2_000);
    };
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    const events: ProviderStreamEvent[] = [];
    for await (const event of adapter.stream({ prompt: 'x', timeout: 10_000 })) events.push(event);
    expect(events.filter((event) => event.type === 'content_delta')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ headersTimeout: 11_000, bodyTimeout: 11_000 });
  }, 15_000);
});

describe("Node fetch's own limits on a reused connection", () => {
  // Undici runs its header and body limits on a 499 ms tick that can fire up to half a second
  // before the delay. Set equal to the request's timeout, they beat its timer on a kept-alive
  // connection (at 1497 ms, every time) and the call failed as a bare `fetch failed`.
  const TIMEOUT = 1_497;

  it('still ends a stalled call as the request timeout', async () => {
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    for (let round = 0; round < 2; round += 1) {
      handler = (_req, res) => openAIChatAnswer(res);
      // Leaves a kept-alive connection for the next request.
      expect((await adapter.complete({ prompt: 'warm', timeout: 5_000 })).content).toBe('ok');
      handler = stall;
      expectTimeout(
        await rejectionOf(adapter.complete({ prompt: 'x', timeout: TIMEOUT })),
        'openai',
        TIMEOUT,
      );
    }
  }, 15_000);
});

describe('the dispatcher a request goes through', () => {
  it('uses the legacy dispatcher when only v1 is available, then restores both globals', async () => {
    handler = (_req, res) => openAIChatAnswer(res);
    const restoreDispatchers = preserveDispatchers();
    const { dispatcher } = activeDispatcher();
    const dispatch = vi.fn(dispatcher.dispatch.bind(dispatcher));
    try {
      // Assignment also works when Node 24's existing v2 slot cannot be deleted.
      dispatcherGlobals[DISPATCHER_V2] = undefined;
      dispatcherGlobals[DISPATCHER_V1] = { dispatch };
      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
      expect((await adapter.complete({ prompt: 'x', timeout: 7_000 })).content).toBe('ok');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        headersTimeout: 8_000,
        bodyTimeout: 8_000,
      });
    } finally {
      restoreDispatchers();
    }
  });

  it("prefers undici 7.27+'s `undici.globalDispatcher.2` when the process has one", async () => {
    handler = (_req, res) => openAIChatAnswer(res);
    const restoreDispatchers = preserveDispatchers();
    const { dispatcher } = activeDispatcher();
    const legacyDispatch = vi.fn(dispatcher.dispatch.bind(dispatcher));
    const seen: Record<string, unknown>[] = [];
    // Deliberately distinguish the two slots. Node 24's v2 property is non-configurable;
    // Node 22 temporarily gains a v2 property that must be removed on restoration.
    try {
      dispatcherGlobals[DISPATCHER_V1] = { dispatch: legacyDispatch };
      dispatcherGlobals[DISPATCHER_V2] = {
        dispatch(options: Record<string, unknown>, dispatchHandler: unknown) {
          seen.push(options);
          return dispatcher.dispatch(options, dispatchHandler);
        },
      };
      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
      expect((await adapter.complete({ prompt: 'x', timeout: 7_000 })).content).toBe('ok');
    } finally {
      restoreDispatchers();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ headersTimeout: 8_000, bodyTimeout: 8_000 });
    expect(legacyDispatch).not.toHaveBeenCalled();
  });

  it('restores the process dispatcher after a request rejects', async () => {
    const restoreDispatchers = preserveDispatchers();
    const failure = new Error('fixture dispatch failed');
    const { key } = activeDispatcher();
    try {
      dispatcherGlobals[key] = {
        dispatch() {
          throw failure;
        },
      };
      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
      const error = await rejectionOf(adapter.complete({ prompt: 'x', timeout: 7_000 }));
      expect((error as Error & { cause: unknown }).cause).toBe(failure);
    } finally {
      restoreDispatchers();
    }

    handler = (_req, res) => openAIChatAnswer(res);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    expect((await adapter.complete({ prompt: 'after restoration', timeout: 7_000 })).content).toBe(
      'ok',
    );
  });
});
