import { describe, expect, it, vi } from 'vitest';
import {
  type AIProviderAdapter,
  createAnthropicAdapter,
  createOpenAIAdapter,
  createProviderAdapter,
  joinAndFilterModels,
  type ListModelsFilter,
  ProviderAPIError,
} from '../provider.js';
import { AIIncompleteOutputError, AIRefusalError } from '../refusal.js';

// The built-in OpenAI and Anthropic adapters always implement `listModels`;
// the interface marks it optional only for third-party adapters. This helper
// narrows the type so tests don't need non-null assertions on every call.
function callListModels(adapter: AIProviderAdapter, filter?: ListModelsFilter) {
  if (!adapter.listModels) throw new Error('adapter must implement listModels');
  return adapter.listModels(filter);
}

// ── Helper: create a mock provider ──
// biome-ignore lint/suspicious/noExportsInTest: shared test helper used by multiple test files
export function createMockProvider(overrides?: Partial<AIProviderAdapter>): AIProviderAdapter {
  return {
    name: 'mock',
    complete: vi.fn(async () => ({
      content: '{"result": "test"}',
      model: 'mock-model',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
    })),
    async *stream() {
      yield { type: 'content_delta' as const, delta: 'mock' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    embed: vi.fn(async () => ({
      embeddings: [[0.1, 0.2, 0.3]],
      model: 'mock-embed',
      usage: { totalTokens: 5 },
      cost: 0,
    })),
    ...overrides,
  };
}

describe('AI Provider Adapters', () => {
  describe('createOpenAIAdapter', () => {
    it("creates an adapter with name 'openai'", () => {
      const adapter = createOpenAIAdapter({ apiKey: 'test-key' });
      expect(adapter.name).toBe('openai');
    });

    it('calls OpenAI chat completions endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const result = await adapter.complete({ prompt: 'Say hello' });

      expect(result.content).toBe('Hello');
      expect(result.model).toBe('gpt-4o');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      expect(result.usage.cachedInputTokens).toBe(4);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );

      vi.unstubAllGlobals();
    });

    it('sends system message when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({ prompt: 'Hello', system: 'Be nice' });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');

      vi.unstubAllGlobals();
    });

    it('uses max_completion_tokens for newer OpenAI completion models', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
          model: 'gpt-5-mini',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5-mini' });
      await adapter.complete({ prompt: 'Say hello', maxTokens: 1234 });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.max_completion_tokens).toBe(1234);
      expect(body.max_tokens).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('uses max_completion_tokens for newer OpenAI streaming models', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'o4-mini' });
      for await (const event of adapter.stream({ prompt: 'Stream hello', maxTokens: 4321 })) {
        expect(event.type).toBe('done');
        break;
      }

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.max_completion_tokens).toBe(4321);
      expect(body.max_tokens).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('sends strict JSON Schema response_format when responseSchema is provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"name":"Alice"}' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({
        prompt: 'Return JSON',
        responseFormat: 'json',
        responseSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      });

      vi.unstubAllGlobals();
    });

    it('uses strict tool-call arguments for Grok structured output', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      name: 'return_structured_response',
                      arguments: '{"name":"Alice"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          model: 'grok-4-1-fast-non-reasoning',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({
        apiKey: 'sk-test',
        model: 'grok-4-1-fast-non-reasoning',
      });
      const result = await adapter.complete({
        prompt: 'Return JSON',
        responseFormat: 'json',
        structuredOutputTransport: 'tool',
        responseSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.response_format).toBeUndefined();
      expect(body.tool_choice).toEqual({
        type: 'function',
        function: { name: 'return_structured_response' },
      });
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'return_structured_response',
            description: 'Return the complete structured response for this request.',
            strict: true,
            parameters: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
      ]);
      expect(result.content).toBe('{"name":"Alice"}');
      expect(result.finishReason).toBe('tool_calls');

      vi.unstubAllGlobals();
    });

    it('keeps Grok structured output on response_format unless explicitly opted into tools', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"name":"Alice"}' }, finish_reason: 'stop' }],
          model: 'grok-4-1-fast-non-reasoning',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({
        apiKey: 'sk-test',
        model: 'grok-4-1-fast-non-reasoning',
      });
      await adapter.complete({
        prompt: 'Return JSON',
        responseFormat: 'json',
        responseSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.response_format?.type).toBe('json_schema');

      vi.unstubAllGlobals();
    });

    it('throws a descriptive error when structured JSON content is empty', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chatcmpl-empty',
          choices: [
            {
              message: { content: null, role: 'assistant' },
              finish_reason: 'stop',
            },
          ],
          model: 'grok-4-1-fast-non-reasoning',
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({
        apiKey: 'sk-test',
        model: 'grok-4-1-fast-non-reasoning',
      });
      await expect(
        adapter.complete({
          prompt: 'Return JSON',
          responseFormat: 'json',
          responseSchema: {
            type: 'object',
            properties: { evidence: { type: 'array', items: { type: 'object' } } },
            required: ['evidence'],
            additionalProperties: false,
          },
        }),
      ).rejects.toThrow(
        /OpenAI-compatible provider returned empty JSON response content .*finish_reason=stop/,
      );
      // Ensure the framework does NOT phone home to a debug ingest endpoint.
      const debugCall = mockFetch.mock.calls.find(([url]) => String(url).includes('/ingest/'));
      expect(debugCall).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('throws AIRefusalError when OpenAI returns a refusal', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: null, refusal: 'No.' }, finish_reason: 'stop' }],
            model: 'gpt-4o',
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        }),
      );

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.complete({ prompt: 'bad', responseFormat: 'json' })).rejects.toThrow(
        AIRefusalError,
      );

      vi.unstubAllGlobals();
    });

    it('throws AIIncompleteOutputError when OpenAI stops for length', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }],
            model: 'gpt-4o',
            usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 },
          }),
        }),
      );

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.complete({ prompt: 'long', responseFormat: 'json' })).rejects.toThrow(
        AIIncompleteOutputError,
      );

      vi.unstubAllGlobals();
    });

    it('throws on non-retryable API error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () => 'rate limited',
        }),
      );

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.complete({ prompt: 'test' })).rejects.toThrow('OpenAI API error (400)');

      vi.unstubAllGlobals();
    });

    it('retries transient API errors before succeeding', async () => {
      vi.useFakeTimers();
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => 'capacity',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Recovered' }, finish_reason: 'stop' }],
            model: 'gpt-4o',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const resultPromise = adapter.complete({ prompt: 'retry me' });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.content).toBe('Recovered');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('throws ProviderAPIError after exhausting transient retries', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => 'still unavailable',
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const errorPromise = adapter.complete({ prompt: 'retry me' }).then(
        () => new Error('Expected provider error'),
        (reason) => reason,
      );

      await vi.runAllTimersAsync();
      const error = await errorPromise;

      expect(error).toBeInstanceOf(ProviderAPIError);
      expect(error).toMatchObject({
        providerName: 'openai',
        retryable: true,
        statusCode: 503,
        attempts: 3,
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('calls embeddings endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          model: 'text-embedding-3-small',
          usage: { total_tokens: 8 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const result = await adapter.embed({ texts: ['hello world'] });

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result.model).toBe('text-embedding-3-small');
      expect(result.usage.totalTokens).toBe(8);

      vi.unstubAllGlobals();
    });

    it('computes cost from the pricing catalog for a known embedding model', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1] }],
          model: 'text-embedding-3-large',
          usage: { total_tokens: 1_000_000 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const result = await adapter.embed({ texts: ['x'] });

      // text-embedding-3-large: $0.13 per 1M input tokens → 1M tokens = $0.13
      expect(result.cost).toBeCloseTo(0.13, 6);

      vi.unstubAllGlobals();
    });

    it('returns cost=0 for an embedding model not in the pricing catalog', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1] }],
          model: 'custom-embedding-model-not-in-catalog',
          usage: { total_tokens: 1000 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const result = await adapter.embed({ texts: ['x'] });

      expect(result.cost).toBe(0);

      vi.unstubAllGlobals();
    });

    it('sends multi-turn messages verbatim and does not append prompt as an extra user message', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({
        prompt: 'IGNORED_WHEN_MESSAGES',
        system: 'Sys',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
          { role: 'user', content: 'Last' },
        ],
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body as string);
      expect(body.messages).toEqual([
        { role: 'system', content: 'Sys' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Last' },
      ]);

      vi.unstubAllGlobals();
    });

    it('still maps plain user/assistant messages (no tools) unchanged', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({
        prompt: 'fallback',
        messages: [{ role: 'user', content: 'Hello legacy' }],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello legacy' }]);

      vi.unstubAllGlobals();
    });
  });

  describe('createAnthropicAdapter', () => {
    it("creates an adapter with name 'anthropic'", () => {
      const adapter = createAnthropicAdapter({ apiKey: 'test-key' });
      expect(adapter.name).toBe('anthropic');
    });

    it('calls Anthropic messages endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Hello from Claude' }],
          model: 'claude-sonnet-4-20250514',
          usage: {
            input_tokens: 10,
            output_tokens: 8,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
          stop_reason: 'end_turn',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      const result = await adapter.complete({ prompt: 'Say hello' });

      expect(result.content).toBe('Hello from Claude');
      expect(result.usage.totalTokens).toBe(18);
      expect(result.usage.cachedInputTokens).toBe(3);
      expect(result.usage.cacheWriteTokens).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'x-api-key': 'ant-test' }),
        }),
      );

      vi.unstubAllGlobals();
    });

    it('sends Anthropic output_config.format when responseSchema is provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"name":"Alice"}' }],
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 8 },
          stop_reason: 'end_turn',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      await adapter.complete({
        prompt: 'Return JSON',
        responseFormat: 'json',
        responseSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body);
      expect(body.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      });
      expect(call?.[1].headers).not.toHaveProperty('anthropic-beta');

      vi.unstubAllGlobals();
    });

    it('throws AIRefusalError when Anthropic returns stop_reason refusal', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: 'No.' }],
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 10, output_tokens: 2 },
            stop_reason: 'refusal',
          }),
        }),
      );

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      await expect(adapter.complete({ prompt: 'bad', responseFormat: 'json' })).rejects.toThrow(
        AIRefusalError,
      );

      vi.unstubAllGlobals();
    });

    it('throws AIIncompleteOutputError when Anthropic reaches max_tokens', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: '{"partial":' }],
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 10, output_tokens: 8 },
            stop_reason: 'max_tokens',
          }),
        }),
      );

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      await expect(adapter.complete({ prompt: 'long', responseFormat: 'json' })).rejects.toThrow(
        AIIncompleteOutputError,
      );

      vi.unstubAllGlobals();
    });

    it('throws on embed (unsupported)', async () => {
      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      await expect(adapter.embed({ texts: ['hello'] })).rejects.toThrow(
        'Anthropic does not provide an embedding API',
      );
    });

    it('sends multi-turn messages verbatim when messages array is provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      await adapter.complete({
        prompt: 'IGNORED',
        system: 'Merged system text',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Second' },
        ],
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1].body as string);
      expect(body.system).toBe('Merged system text');
      expect(body.messages).toEqual([
        { role: 'user', content: 'First' },
        { role: 'assistant', content: [{ type: 'text', text: 'Second' }] },
      ]);

      vi.unstubAllGlobals();
    });
  });

  describe('external AbortSignal propagation', () => {
    it('fetch is called with a signal that fires when the caller aborts', async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        // Never resolves unless aborted — simulates an in-flight long request.
        return await new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const ac = new AbortController();

      const p = adapter.complete({ prompt: 'long', signal: ac.signal });
      // Give the mock a tick to be called.
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();

      await expect(p).rejects.toThrow(/abort/i);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);

      vi.unstubAllGlobals();
    });

    it('completing normally before abort does not surface as aborted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const ac = new AbortController(); // never aborted

      const result = await adapter.complete({ prompt: 'fast', signal: ac.signal });
      expect(result.content).toBe('ok');

      vi.unstubAllGlobals();
    });

    it('uses a 600 second default request timeout for OpenAI-compatible calls', async () => {
      const originalTimeout = AbortSignal.timeout;
      let capturedTimeoutMs: number | undefined;
      const timeoutSpy = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((timeoutMs: number) => {
          capturedTimeoutMs = timeoutMs;
          return originalTimeout.call(AbortSignal, timeoutMs);
        });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({ prompt: 'fast' });

      expect(capturedTimeoutMs).toBe(120_000);

      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe('createProviderAdapter', () => {
    it('creates an OpenAI adapter for "openai"', () => {
      const adapter = createProviderAdapter('openai', { provider: 'openai', apiKey: 'sk-test' });
      expect(adapter.name).toBe('openai');
    });

    it('creates an Anthropic adapter for "anthropic"', () => {
      const adapter = createProviderAdapter('anthropic', {
        provider: 'anthropic',
        apiKey: 'ant-test',
      });
      expect(adapter.name).toBe('anthropic');
    });

    it('throws for unsupported provider names', () => {
      expect(() =>
        createProviderAdapter('ollama', {
          provider: 'ollama',
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
        }),
      ).toThrow(/Unsupported AI provider "ollama"/);
    });
  });

  describe('joinAndFilterModels', () => {
    it('joins entries against the pricing catalog (kind + prices for known, unknown otherwise)', () => {
      const result = joinAndFilterModels({
        provider: 'openai',
        entries: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'llama3:8b' }],
        filter: undefined,
        isOfficial: true,
      });
      expect(result).toHaveLength(3);
      const gpt = result.find((m) => m.id === 'gpt-4o');
      expect(gpt?.kind).toBe('text');
      expect(gpt?.inputPerMTok).toBe(2.5);
      const emb = result.find((m) => m.id === 'text-embedding-3-small');
      expect(emb?.kind).toBe('embedding');
      const llama = result.find((m) => m.id === 'llama3:8b');
      expect(llama?.kind).toBe('unknown');
      expect(llama?.inputPerMTok).toBeNull();
      expect(llama?.outputPerMTok).toBeNull();
    });

    it('passes through every entry when no filter is supplied', () => {
      const r = joinAndFilterModels({
        provider: 'openai',
        entries: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'mystery' }],
        filter: undefined,
        isOfficial: false,
      });
      expect(r.map((m) => m.id)).toEqual(['gpt-4o', 'text-embedding-3-small', 'mystery']);
    });

    it('single-kind filter against the official endpoint excludes unknowns', () => {
      const r = joinAndFilterModels({
        provider: 'openai',
        entries: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'nomic-embed' }],
        filter: { kind: 'embedding' },
        isOfficial: true,
      });
      expect(r.map((m) => m.id)).toEqual(['text-embedding-3-small']);
    });

    it('single-kind filter against a custom endpoint includes unknowns alongside matches', () => {
      const r = joinAndFilterModels({
        provider: 'ollama',
        entries: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'nomic-embed' }],
        filter: { kind: 'embedding' },
        isOfficial: false,
      });
      expect(r.map((m) => m.id).sort()).toEqual(['nomic-embed', 'text-embedding-3-small']);
    });

    it('multi-kind filter accepts arrays', () => {
      const r = joinAndFilterModels({
        provider: 'openai',
        entries: [
          { id: 'gpt-4o' },
          { id: 'text-embedding-3-small' },
          { id: 'omni-moderation-latest' },
        ],
        filter: { kind: ['text', 'embedding'] },
        isOfficial: true,
      });
      expect(r.map((m) => m.id).sort()).toEqual(['gpt-4o', 'text-embedding-3-small']);
    });

    it('carries through optional displayName / createdAt / ownedBy fields', () => {
      const r = joinAndFilterModels({
        provider: 'anthropic',
        entries: [
          {
            id: 'claude-opus-4-7',
            displayName: 'Claude Opus 4.7',
            createdAt: '2026-01-15T00:00:00Z',
          },
        ],
        filter: undefined,
        isOfficial: true,
      });
      expect(r[0]?.displayName).toBe('Claude Opus 4.7');
      expect(r[0]?.createdAt).toBe('2026-01-15T00:00:00Z');
    });
  });

  describe('OpenAI listModels', () => {
    it('returns joined entries from /v1/models with kind + pricing', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'system' },
            {
              id: 'text-embedding-3-small',
              object: 'model',
              created: 1700000000,
              owned_by: 'openai',
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const models = await callListModels(adapter);

      const call = mockFetch.mock.calls[0];
      expect(call?.[0]).toBe('https://api.openai.com/v1/models');
      expect(call?.[1].headers.Authorization).toBe('Bearer sk-test');

      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        id: 'gpt-4o',
        provider: 'openai',
        kind: 'text',
        inputPerMTok: 2.5,
        outputPerMTok: 10,
        ownedBy: 'system',
      });
      expect(models[0]?.createdAt).toBe(new Date(1715367049 * 1000).toISOString());

      vi.unstubAllGlobals();
    });

    it('filters by kind against the official endpoint (unknowns excluded)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o' },
            { id: 'text-embedding-3-small' },
            { id: 'fine-tune-ft-custom-12345' },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const models = await callListModels(adapter, { kind: 'embedding' });
      expect(models.map((m) => m.id)).toEqual(['text-embedding-3-small']);

      vi.unstubAllGlobals();
    });

    it('filters by kind against a custom endpoint and includes unknowns', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'nomic-embed-text' }, { id: 'llama3:8b' }],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({
        apiKey: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
      });
      const models = await callListModels(adapter, { kind: 'embedding' });
      // text-known stays out, but both unknowns (nomic-embed-text, llama3:8b) come through.
      expect(models.map((m) => m.id).sort()).toEqual(['llama3:8b', 'nomic-embed-text']);

      vi.unstubAllGlobals();
    });

    it('returns empty list and warns on 404 (endpoint not implemented)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      vi.stubGlobal('fetch', mockFetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const adapter = createOpenAIAdapter({
        apiKey: 'azure-key',
        baseUrl: 'https://example.openai.azure.com/openai/v1',
      });
      const models = await callListModels(adapter);
      expect(models).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/returned 404/);

      warn.mockRestore();
      vi.unstubAllGlobals();
    });

    it('returns empty list and warns on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const models = await callListModels(adapter);
      expect(models).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/ECONNREFUSED/);

      warn.mockRestore();
      vi.unstubAllGlobals();
    });

    it('returns empty list when response shape is unexpected', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: 'hello' }),
      });
      vi.stubGlobal('fetch', mockFetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const models = await callListModels(adapter);
      expect(models).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe('Anthropic listModels', () => {
    it('returns joined entries from /v1/models with displayName + createdAt', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'claude-opus-4-7',
              type: 'model',
              display_name: 'Claude Opus 4.7',
              created_at: '2026-01-15T00:00:00Z',
            },
            {
              id: 'claude-sonnet-4-6',
              type: 'model',
              display_name: 'Claude Sonnet 4.6',
              created_at: '2025-09-01T00:00:00Z',
            },
          ],
          has_more: false,
          last_id: 'claude-sonnet-4-6',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      const models = await callListModels(adapter);

      const call = mockFetch.mock.calls[0];
      expect(String(call?.[0])).toContain('https://api.anthropic.com/v1/models');
      expect(call?.[1].headers['x-api-key']).toBe('ant-test');
      expect(call?.[1].headers['anthropic-version']).toBe('2023-06-01');

      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        id: 'claude-opus-4-7',
        provider: 'anthropic',
        kind: 'text',
        inputPerMTok: 5,
        outputPerMTok: 25,
        displayName: 'Claude Opus 4.7',
        createdAt: '2026-01-15T00:00:00Z',
      });

      vi.unstubAllGlobals();
    });

    it('paginates via has_more / last_id', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }],
            has_more: true,
            last_id: 'claude-opus-4-7',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }],
            has_more: false,
            last_id: 'claude-sonnet-4-6',
          }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });
      const models = await callListModels(adapter);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const page2Url = String(mockFetch.mock.calls[1]?.[0]);
      expect(page2Url).toContain('after_id=claude-opus-4-7');
      expect(models.map((m) => m.id)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);

      vi.unstubAllGlobals();
    });

    it('returns empty list and warns on 401', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });
      vi.stubGlobal('fetch', mockFetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const adapter = createAnthropicAdapter({ apiKey: 'bad-key' });
      const models = await callListModels(adapter);
      expect(models).toEqual([]);
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
      vi.unstubAllGlobals();
    });

    it('filters by kind (Anthropic models are all text)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
          ],
          has_more: false,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'ant-test' });

      const embeddings = await callListModels(adapter, { kind: 'embedding' });
      expect(embeddings).toEqual([]);

      const texts = await callListModels(adapter, { kind: 'text' });
      expect(texts.map((m) => m.id)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);

      vi.unstubAllGlobals();
    });
  });
});
