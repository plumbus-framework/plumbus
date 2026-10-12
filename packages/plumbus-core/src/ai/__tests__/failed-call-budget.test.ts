import { createServer } from 'node:net';
import { DecisionProviderError } from '@plumbus/ai-decision';
import type { DecisionProviderAdapter, DecisionResult } from '@plumbus/ai-decision/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { createCostTracker } from '../cost-tracker.js';
import { estimateModelCost } from '../model-pricing.js';
import {
  type AIProviderAdapter,
  createAnthropicAdapter,
  createOpenAIAdapter,
  ProviderAPIError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamEvent,
} from '../provider.js';
import { isCostFreeProviderFailure } from '../provider-failure.js';
import { AIInvalidRequestError, AIRefusalError } from '../refusal.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// What Node's fetch throws when the TCP connection never opens (seen against api.openai.com).
function connectTimeout(): TypeError {
  const cause = Object.assign(
    new Error('Connect Timeout Error (attempted address: api.openai.com:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
  );
  return new TypeError('fetch failed', { cause });
}

// The connection closed after the request was written: the provider may have billed it.
function socketClosed(): TypeError {
  const cause = Object.assign(new Error('other side closed'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET',
  });
  return new TypeError('fetch failed', { cause });
}

function systemError(code: string, syscall?: string): TypeError {
  const cause = Object.assign(new Error(`${syscall ?? 'tls'} ${code}`), { code, syscall });
  return new TypeError('fetch failed', { cause });
}

function openAIAnswer() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    }),
  };
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function answer(overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    content: 'ok',
    model: 'gpt-4o',
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    finishReason: 'stop',
    ...overrides,
  };
}

/** A provider whose attempts run the given steps in order (the last one repeats). */
function scriptedProvider(
  name: string,
  steps: Array<(request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>>,
): AIProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    name,
    requests,
    async complete(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (!step) throw new Error('no scripted step');
      return step(request);
    },
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'done' };
    },
    async embed() {
      return { embeddings: [], model: 'embed', usage: { totalTokens: 0 } };
    },
  };
}

/** The budget's input estimate for a request: UTF-8 bytes of its content over four. */
function inputEstimate(request: ProviderRequest | undefined): number {
  const input = JSON.stringify({
    system: request?.system,
    prompt: request?.prompt,
    messages: request?.messages,
    tools: request?.tools,
    responseSchema: request?.responseSchema,
  });
  return Math.ceil(Buffer.byteLength(input, 'utf8') / 4);
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('isCostFreeProviderFailure', () => {
  it.each([
    ['undici connect timeout', connectTimeout()],
    ['connection refused', systemError('ECONNREFUSED', 'connect')],
    ['TCP connect timeout', systemError('ETIMEDOUT', 'connect')],
    ['unknown host', systemError('ENOTFOUND', 'getaddrinfo')],
    ['DNS lookup retry', systemError('EAI_AGAIN', 'getaddrinfo')],
    ['TLS hostname mismatch', systemError('ERR_TLS_CERT_ALTNAME_INVALID')],
    ['self-signed certificate', systemError('DEPTH_ZERO_SELF_SIGNED_CERT')],
    [
      'every address refused',
      new TypeError('fetch failed', {
        cause: new AggregateError([
          Object.assign(new Error('a'), { code: 'ECONNREFUSED', syscall: 'connect' }),
          Object.assign(new Error('b'), { code: 'ENETUNREACH', syscall: 'connect' }),
        ]),
      }),
    ],
    ['local request validation', new AIInvalidRequestError({ reason: 'duplicate_tool_name' })],
    [
      'rejected credentials',
      new ProviderAPIError({
        providerName: 'openai',
        message: 'x',
        retryable: false,
        attempts: 1,
        statusCode: 401,
      }),
    ],
    [
      'rate limited',
      new ProviderAPIError({
        providerName: 'openai',
        message: 'x',
        retryable: true,
        attempts: 3,
        statusCode: 429,
      }),
    ],
    [
      'AWS SDK throttling',
      Object.assign(new Error('Throttling'), { $metadata: { httpStatusCode: 429 } }),
    ],
  ])('treats %s as never billed', (_label, error) => {
    expect(isCostFreeProviderFailure(error)).toBe(true);
  });

  it.each([
    ['socket closed after the request', socketClosed()],
    ['connection reset while reading', systemError('ECONNRESET', 'read')],
    [
      'headers timeout',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('Headers Timeout Error'), {
          code: 'UND_ERR_HEADERS_TIMEOUT',
        }),
      }),
    ],
    [
      'server error',
      new ProviderAPIError({
        providerName: 'openai',
        message: 'x',
        retryable: true,
        attempts: 3,
        statusCode: 503,
      }),
    ],
    [
      'model timeout (Bedrock 408)',
      Object.assign(new Error('ModelTimeoutException'), { $metadata: { httpStatusCode: 408 } }),
    ],
    [
      'model error while processing (Bedrock 424)',
      Object.assign(new Error('ModelErrorException'), { $metadata: { httpStatusCode: 424 } }),
    ],
    ['abort during the call', new DOMException('This operation was aborted', 'AbortError')],
    ['opaque error', new Error('boom')],
    ['refusal', new AIRefusalError({ provider: 'openai', model: 'gpt-4o', refusalText: 'no' })],
    ['a string', 'fetch failed'],
    ['nothing', undefined],
  ])('treats %s as possibly billed', (_label, error) => {
    expect(isCostFreeProviderFailure(error)).toBe(false);
  });
});

describe('createCostTracker with failed calls', () => {
  const base = {
    provider: 'openai',
    model: 'gpt-4o',
    operation: 'generate' as const,
    latencyMs: 1,
  };

  it('charges an estimate while the cost is unknown and refuses only past the limit', () => {
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    tracker.record({ ...base, usage: zeroUsage, cost: null, estimatedCost: 0.4, status: 'failed' });
    expect(tracker.checkBudget({}).allowed).toBe(true);
    expect(tracker.checkBudget({ estimatedCostUsd: 0.5 }).allowed).toBe(true);
    tracker.record({ ...base, usage: zeroUsage, cost: null, estimatedCost: 0.6, status: 'failed' });
    expect(tracker.checkBudget({})).toEqual({
      allowed: false,
      reason: 'Daily cost limit reached ($1.0000 / $1)',
    });
    // The estimate is a budget charge, not spend: the ledger still says the cost is unknown.
    expect(tracker.getRecords()[0]).toMatchObject({ cost: null, estimatedCost: 0.4 });
    expect(tracker.getDailyUsage()).toMatchObject({ totalCost: 0, costAvailable: false });
  });

  it('lets a known cost supersede an estimate and drops an invalid estimate', () => {
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    tracker.record({ ...base, usage: zeroUsage, cost: 0.1, estimatedCost: 5 });
    tracker.record({
      ...base,
      usage: zeroUsage,
      cost: null,
      estimatedCost: Number.NaN,
      status: 'failed',
    });
    const [priced, invalid] = tracker.getRecords();
    expect(priced).not.toHaveProperty('estimatedCost');
    expect(invalid).not.toHaveProperty('estimatedCost');
    expect(tracker.checkBudget({}).allowed).toBe(true);
  });

  it('does not let a failed call that brought nothing back refuse later calls', () => {
    const tracker = createCostTracker({ dailyCostLimit: 1, perTenantDailyLimit: 1 });
    tracker.record({ ...base, usage: zeroUsage, cost: null, status: 'failed', tenantId: 't1' });
    expect(tracker.checkBudget({ tenantId: 't1' }).allowed).toBe(true);
    expect(
      tracker.checkBudget({ tenantId: 't1', provider: 'openai', model: 'gpt-4o' }).allowed,
    ).toBe(true);
  });

  it('refuses calls that would add unpriced spend, and only those', () => {
    const tracker = createCostTracker({ dailyCostLimit: 1, perTenantDailyLimit: 1 });
    tracker.record({
      ...base,
      provider: 'local',
      model: 'llama',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      cost: null,
      tenantId: 't1',
    });
    expect(tracker.checkBudget({ provider: 'local', model: 'llama' })).toEqual({
      allowed: false,
      reason:
        'Cost data unavailable for prior local llama requests — daily budget cannot be enforced for them.',
    });
    expect(tracker.checkBudget({ provider: 'openai', model: 'gpt-4o' }).allowed).toBe(true);
    // Media, decisions and other callers that cannot name a model stay fail-closed.
    expect(tracker.checkBudget({}).reason).toBe(
      'Cost data unavailable for prior requests — daily budget cannot be enforced.',
    );
    const tenantOnly = createCostTracker({ perTenantDailyLimit: 1 });
    tenantOnly.record({
      ...base,
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      cost: null,
      tenantId: 't1',
    });
    expect(tenantOnly.checkBudget({ tenantId: 't1' }).reason).toContain('tenant budget');
    expect(tenantOnly.checkBudget({ tenantId: 't2' }).allowed).toBe(true);
  });
});

describe('AI service accounting for failed calls', () => {
  it('records a connect timeout as zero spend so the next call succeeds under the limit', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectTimeout())
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValue(openAIAnswer());
    vi.stubGlobal('fetch', fetchMock);
    const tracker = createCostTracker({ dailyCostLimit: 6 });
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test' }), {
        defaultModel: 'gpt-4o-mini',
        costTracker: tracker,
      }),
    );

    await expect(ai.generate({ prompt: 'hello', input: {} })).rejects.toThrow('fetch failed');
    await expect(ai.generate({ prompt: 'hello', input: {} })).rejects.toThrow('fetch failed');
    await expect(ai.generate({ prompt: 'hello', input: {} })).resolves.toBe('ok');

    const rows = tracker.getRecords();
    expect(rows.map((row) => [row.status, row.cost])).toEqual([
      ['failed', 0],
      ['failed', 0],
      ['success', estimateModelCost(1000, 500, 'gpt-4o-mini')],
    ]);
    expect(rows[0]).not.toHaveProperty('estimatedCost');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('records a real refused connection as zero spend', async () => {
    const port = await closedPort();
    const tracker = createCostTracker({ dailyCostLimit: 6 });
    const ai = createAIService(
      singleProviderConfig(
        createOpenAIAdapter({ apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${port}/v1` }),
        { defaultModel: 'gpt-4o-mini', costTracker: tracker },
      ),
    );
    const error = await ai.generate({ prompt: 'hello', input: {} }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).cause).toMatchObject({ code: 'ECONNREFUSED' });
    expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0 });
    expect(tracker.checkBudget({ provider: 'openai', model: 'gpt-4o-mini' }).allowed).toBe(true);
  });

  it('charges a call dropped after sending its input estimate plus the default output allowance', async () => {
    const provider = scriptedProvider('openai', [
      () => {
        throw socketClosed();
      },
    ]);
    const tracker = createCostTracker({ dailyCostLimit: 0.06 });
    const ai = createAIService(
      singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
    );

    await expect(ai.generate({ prompt: 'hello', input: {} })).rejects.toThrow('fetch failed');
    const charge = estimateModelCost(inputEstimate(provider.requests[0]), 4096, 'gpt-4o');
    expect(charge).toBeGreaterThan(0.04);
    expect(tracker.getRecords()[0]).toMatchObject({
      status: 'failed',
      cost: null,
      estimatedCost: charge,
      usage: zeroUsage,
    });

    // Still under the limit: the budget keeps working instead of locking the day.
    await expect(ai.generate({ prompt: 'hello', input: {} })).rejects.toThrow('fetch failed');
    // Two estimates now exceed it, and the refusal says so.
    await expect(ai.generate({ prompt: 'hello', input: {} })).rejects.toThrow(
      /Daily cost limit reached/,
    );
    expect(provider.requests).toHaveLength(2);
  });

  it("charges the request's own output cap when it has one", async () => {
    const provider = scriptedProvider('openai', [
      () => {
        throw socketClosed();
      },
    ]);
    const tracker = createCostTracker({ dailyCostLimit: 6 });
    const ai = createAIService(
      singleProviderConfig(provider, {
        defaultModel: 'gpt-4o',
        costTracker: tracker,
        prompts: [
          definePrompt({
            name: 'summarize',
            description: 'Summarize {{text}}',
            input: z.object({ text: z.string() }),
            output: z.string(),
            model: { maxTokens: 50_000 },
          }),
        ],
      }),
    );
    await expect(ai.generate({ prompt: 'summarize', input: { text: 'notes' } })).rejects.toThrow(
      'fetch failed',
    );
    expect(tracker.getRecords()[0]?.estimatedCost).toBe(
      estimateModelCost(inputEstimate(provider.requests[0]), 50_000, 'gpt-4o'),
    );
    expect(tracker.checkBudget({ provider: 'openai', model: 'gpt-4o' }).allowed).toBe(true);
  });

  it('records a 4xx rejection as zero spend and estimates a 5xx', async () => {
    const rejected = (statusCode: number) =>
      new ProviderAPIError({
        providerName: 'openai',
        message: `OpenAI API error (${statusCode})`,
        retryable: false,
        attempts: 1,
        statusCode,
      });
    const provider = scriptedProvider('openai', [
      () => {
        throw rejected(401);
      },
      () => {
        throw rejected(501);
      },
    ]);
    const tracker = createCostTracker({ dailyCostLimit: 6 });
    const ai = createAIService(
      singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
    );
    await expect(ai.generate({ prompt: 'a', input: {} })).rejects.toThrow('(401)');
    await expect(ai.generate({ prompt: 'b', input: {} })).rejects.toThrow('(501)');
    const [unauthorized, serverError] = tracker.getRecords();
    expect(unauthorized).toMatchObject({ cost: 0 });
    expect(serverError).toMatchObject({ cost: null });
    expect(serverError?.estimatedCost).toBeGreaterThan(0);
  });

  it('records an attempt aborted before sending as zero spend and one aborted in flight as estimated', async () => {
    const controller = new AbortController();
    const provider = scriptedProvider('openai', [
      (request) => {
        if (request.signal?.aborted)
          throw new DOMException('This operation was aborted', 'AbortError');
        controller.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    ]);
    const tracker = createCostTracker({ dailyCostLimit: 6 });
    const ai = createAIService(
      singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
    );
    await expect(
      ai.generate({ prompt: 'in flight', input: {}, signal: controller.signal }),
    ).rejects.toThrow('aborted');
    await expect(
      ai.generate({ prompt: 'before send', input: {}, signal: controller.signal }),
    ).rejects.toThrow('aborted');
    const [inFlight, beforeSend] = tracker.getRecords();
    expect(inFlight?.estimatedCost).toBeGreaterThan(0);
    expect(beforeSend).toMatchObject({ cost: 0 });
  });

  it('keeps the usage of answered validation attempts when a later attempt never connects', async () => {
    const provider = scriptedProvider('openai', [
      () => answer({ content: 'not json', model: 'gpt-4o-mini' }),
      () => {
        throw connectTimeout();
      },
    ]);
    const tracker = createCostTracker({ dailyCostLimit: 6 });
    const ai = createAIService(
      singleProviderConfig(provider, {
        defaultModel: 'gpt-4o-mini',
        costTracker: tracker,
        prompts: [
          definePrompt({
            name: 'structured',
            description: 'Return {{x}} as JSON',
            input: z.object({ x: z.string() }),
            output: z.object({ ok: z.boolean(), name: z.string() }),
          }),
        ],
      }),
    );
    await expect(ai.generate({ prompt: 'structured', input: { x: 'y' } })).rejects.toThrow(
      'fetch failed',
    );
    expect(tracker.getRecords()[0]).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      cost: estimateModelCost(100, 10, 'gpt-4o-mini'),
    });
    expect(tracker.getRecords()[0]).not.toHaveProperty('estimatedCost');
  });

  it('charges adapter-priced answers and nothing for a dropped attempt on an unpriced model', async () => {
    const provider = scriptedProvider('custom', [
      () => answer({ content: 'not json', model: 'custom-model', cost: 0.3 }),
      () => {
        throw socketClosed();
      },
    ]);
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    const ai = createAIService(
      singleProviderConfig(provider, {
        defaultModel: 'custom-model',
        costTracker: tracker,
        prompts: [
          definePrompt({
            name: 'structured',
            description: 'Return {{x}} as JSON',
            input: z.object({ x: z.string() }),
            output: z.object({ ok: z.boolean() }),
          }),
        ],
      }),
    );
    await expect(ai.generate({ prompt: 'structured', input: { x: 'y' } })).rejects.toThrow(
      'fetch failed',
    );
    expect(tracker.getRecords()[0]).toMatchObject({ cost: null, estimatedCost: 0.3 });
    // The dropped attempt cannot be priced; it does not lock out the model's later calls.
    expect(tracker.checkBudget({ provider: 'custom', model: 'custom-model' }).allowed).toBe(true);
  });

  it('refuses further calls to a model answered without a price, but not to other models', async () => {
    const unpriced = scriptedProvider('local', [() => answer({ model: 'llama' })]);
    const priced = scriptedProvider('openai', [() => answer({ model: 'gpt-4o-mini' })]);
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    const ai = createAIService({
      providers: { local: unpriced, openai: priced },
      defaultProvider: 'local',
      costTracker: tracker,
    });

    await ai.generate({ prompt: 'x', input: {}, model: 'llama' });
    await expect(ai.generate({ prompt: 'x', input: {}, model: 'llama' })).rejects.toThrow(
      'Cost data unavailable for prior local llama requests',
    );
    await expect(
      ai.generate({ prompt: 'x', input: {}, provider: 'openai', model: 'gpt-4o-mini' }),
    ).resolves.toBe('ok');
    // A pre-check that cannot name a model (voice, media) stays fail-closed.
    expect(() => ai.checkProviderCostBudget({ estimatedCostUsd: 0.01 })).toThrow(
      'Cost data unavailable for prior requests',
    );
    expect(unpriced.requests).toHaveLength(1);
    expect(tracker.getRecords()).toHaveLength(2);
  });

  it('does not let a refused oversized request lock the dollar budget', async () => {
    const provider = scriptedProvider('openai', [() => answer({ model: 'gpt-4o-mini' })]);
    const tracker = createCostTracker({ maxTokensPerRequest: 50, dailyCostLimit: 1 });
    const ai = createAIService(
      singleProviderConfig(provider, { defaultModel: 'gpt-4o-mini', costTracker: tracker }),
    );
    await expect(ai.generate({ prompt: 'x'.repeat(1000), input: {} })).rejects.toThrow(
      'per-request limit',
    );
    expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0 });
    await expect(ai.generate({ prompt: 'short', input: {} })).resolves.toBe('ok');
    expect(provider.requests).toHaveLength(1);
  });

  describe('streaming', () => {
    function streamingProvider(
      events: (request: ProviderRequest) => AsyncIterable<ProviderStreamEvent>,
    ): AIProviderAdapter & { requests: ProviderRequest[] } {
      const provider = scriptedProvider('openai', [() => answer()]);
      return {
        ...provider,
        stream(request) {
          provider.requests.push(request);
          return events(request);
        },
      };
    }

    async function drain(stream: AsyncIterable<unknown>): Promise<void> {
      for await (const _event of stream) {
        // consume
      }
    }

    it('records a stream that never connected as zero spend', async () => {
      const provider = streamingProvider(async function* () {
        yield* [];
        throw connectTimeout();
      });
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
      );
      await expect(drain(ai.streamGenerate({ prompt: 'x', input: {} }))).rejects.toThrow(
        'fetch failed',
      );
      expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0 });
    });

    it('estimates a stream dropped before usage arrived', async () => {
      const provider = streamingProvider(async function* () {
        yield { type: 'content_delta', delta: 'partial' };
        throw socketClosed();
      });
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
      );
      await expect(drain(ai.streamGenerate({ prompt: 'x', input: {} }))).rejects.toThrow(
        'fetch failed',
      );
      expect(tracker.getRecords()[0]).toMatchObject({
        cost: null,
        estimatedCost: estimateModelCost(inputEstimate(provider.requests[0]), 4096, 'gpt-4o'),
      });
      expect(tracker.checkBudget({ provider: 'openai', model: 'gpt-4o' }).allowed).toBe(true);
    });

    it('prices a provider error event after the answer finished from what it reported', async () => {
      const provider = streamingProvider(async function* () {
        yield { type: 'content_delta', delta: 'done' };
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          cost: 0.02,
        };
        yield { type: 'error', error: 'overloaded' };
      });
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
      );
      await drain(ai.streamGenerate({ prompt: 'x', input: {} }));
      expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0.02 });
      expect(tracker.getRecords()[0]).not.toHaveProperty('estimatedCost');
    });

    it('estimates a provider error event mid-answer, never below what was reported', async () => {
      const reportedCost = 0.5;
      const provider = streamingProvider(async function* () {
        yield {
          type: 'usage',
          usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
          cost: reportedCost,
        };
        yield { type: 'content_delta', delta: 'partial' };
        yield { type: 'error', error: 'overloaded' };
      });
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(provider, { defaultModel: 'gpt-4o', costTracker: tracker }),
      );
      await drain(ai.streamGenerate({ prompt: 'x', input: {} }));
      const estimate = estimateModelCost(inputEstimate(provider.requests[0]), 4096, 'gpt-4o') ?? 0;
      expect(reportedCost).toBeGreaterThan(estimate);
      expect(tracker.getRecords()[0]).toMatchObject({
        status: 'failed',
        cost: null,
        estimatedCost: reportedCost,
        usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
      });
    });
  });

  describe('streaming through the built-in adapters', () => {
    // Built-in adapters report a failed fetch as an opening `error` event, not a throw.
    function sse(chunks: string[], dropAfter = false): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let next = 0;
      return new ReadableStream({
        pull(controller) {
          const chunk = chunks[next++];
          if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
          else if (dropAfter) controller.error(socketClosed());
          else controller.close();
        },
      });
    }

    function openAIStream(): Response {
      return new Response(
        sse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}\n\n',
          'data: [DONE]\n\n',
        ]),
        { status: 200 },
      );
    }

    async function collect(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
      const types: string[] = [];
      for await (const event of stream) types.push(event.type);
      return types;
    }

    it('records an OpenAI stream that never connected as zero spend, then streams under the limit', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(connectTimeout())
        .mockResolvedValue(openAIStream());
      vi.stubGlobal('fetch', fetchMock);
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test' }), {
          defaultModel: 'gpt-4o-mini',
          costTracker: tracker,
        }),
      );

      expect(await collect(ai.streamGenerate({ prompt: 'x', input: {} }))).toEqual(['error']);
      expect(await collect(ai.streamGenerate({ prompt: 'x', input: {} }))).toEqual([
        'delta',
        'done',
      ]);
      const rows = tracker.getRecords();
      expect(rows.map((row) => [row.status, row.cost])).toEqual([
        ['failed', 0],
        ['success', estimateModelCost(1000, 500, 'gpt-4o-mini')],
      ]);
      expect(rows[0]).not.toHaveProperty('estimatedCost');
    });

    it('records an Anthropic stream turned away with a 4xx as zero spend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{"error":"invalid x-api-key"}', { status: 401 })),
      );
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(createAnthropicAdapter({ apiKey: 'sk-test' }), {
          defaultModel: 'claude-sonnet-4-5',
          costTracker: tracker,
        }),
      );
      expect(await collect(ai.streamGenerate({ prompt: 'x', input: {} }))).toEqual(['error']);
      expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0 });
    });

    it('records a stream whose signal was already aborted as zero spend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.signal?.aborted)
            throw new DOMException('This operation was aborted', 'AbortError');
          return openAIStream();
        }),
      );
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test' }), {
          defaultModel: 'gpt-4o-mini',
          costTracker: tracker,
        }),
      );
      const controller = new AbortController();
      controller.abort();
      expect(
        await collect(ai.streamGenerate({ prompt: 'x', input: {}, signal: controller.signal })),
      ).toEqual(['error']);
      expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0 });
    });

    it('estimates an Anthropic stream cut off after its opening usage, not just its input', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            sse(
              [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":1}}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
              ],
              true,
            ),
            { status: 200 },
          ),
        );
      vi.stubGlobal('fetch', fetchMock);
      const anthropic = createAnthropicAdapter({ apiKey: 'sk-test' });
      const requests: ProviderRequest[] = [];
      const adapter: AIProviderAdapter = {
        ...anthropic,
        name: anthropic.name,
        stream(request) {
          requests.push(request);
          return anthropic.stream(request);
        },
      };
      const tracker = createCostTracker({ dailyCostLimit: 6 });
      const ai = createAIService(
        singleProviderConfig(adapter, { defaultModel: 'claude-sonnet-4-5', costTracker: tracker }),
      );
      await expect(collect(ai.streamGenerate({ prompt: 'x', input: {} }))).rejects.toThrow(
        'fetch failed',
      );
      const charge = estimateModelCost(inputEstimate(requests[0]), 4096, 'claude-sonnet-4-5');
      const inputOnly = estimateModelCost(1000, 1, 'claude-sonnet-4-5');
      expect(charge).toBeGreaterThan(inputOnly ?? 0);
      expect(tracker.getRecords()[0]).toMatchObject({
        status: 'failed',
        cost: null,
        estimatedCost: charge,
        usage: { inputTokens: 1000, outputTokens: 1, totalTokens: 1001 },
      });
    });
  });

  it('does not let a decision transport failure lock out later decisions', async () => {
    const result: DecisionResult<{ refund: { type: 'probability'; instructions: string } }> = {
      provider: 'stub',
      model: 'stub-model',
      answers: { refund: { type: 'probability', probability: 0.9 } },
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      cost: 0.01,
      costAvailable: true,
      latencyMs: 1,
    };
    const decide = vi
      .fn()
      .mockRejectedValueOnce(new DecisionProviderError('stub', 'network', 'fetch failed'))
      .mockResolvedValue(result);
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    const ai = createAIService({
      providers: {},
      defaultProvider: '',
      decisions: {
        providers: { stub: { name: 'stub', decide } as DecisionProviderAdapter },
        defaultProvider: 'stub',
      },
      costTracker: tracker,
    });
    const questions = { refund: { type: 'probability', instructions: 'Refund?' } } as const;
    await expect(ai.decide({ state: 'x', questions })).rejects.toMatchObject({ kind: 'network' });
    await expect(ai.decide({ state: 'x', questions })).resolves.toMatchObject({ cost: 0.01 });
    expect(tracker.getRecords().map((row) => row.cost)).toEqual([null, 0.01]);
  });
});
