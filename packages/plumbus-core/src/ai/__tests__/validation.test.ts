import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AIIncompleteOutputError } from '../refusal.js';
import { AIValidationError, generateWithValidation } from '../validation.js';
import { createMockProvider } from './provider.test.js';

describe('generateWithValidation', () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  it('returns validated data on first try', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"name":"Alice","age":30}',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      })),
    });

    const result = await generateWithValidation(provider, { prompt: 'test' }, schema);

    expect(result.data).toEqual({ name: 'Alice', age: 30 });
    expect(result.attempts).toBe(1);
    expect(result.usage.totalTokens).toBe(30);
  });

  it('retries on invalid JSON and succeeds', async () => {
    let callCount = 0;
    const provider = createMockProvider({
      complete: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'not json',
            model: 'mock',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            finishReason: 'stop',
          };
        }
        return {
          content: '{"name":"Bob","age":25}',
          model: 'mock',
          usage: { inputTokens: 15, outputTokens: 20, totalTokens: 35 },
          finishReason: 'stop',
        };
      }),
    });

    const result = await generateWithValidation(provider, { prompt: 'test' }, schema);

    expect(result.data).toEqual({ name: 'Bob', age: 25 });
    expect(result.attempts).toBe(2);
    expect(result.usage.totalTokens).toBe(50); // 15 + 35
  });

  it('accepts JSON wrapped in markdown fences', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '```json\n{"name":"Dana","age":29}\n```',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
        finishReason: 'stop',
      })),
    });

    const result = await generateWithValidation(provider, { prompt: 'test' }, schema);

    expect(result.data).toEqual({ name: 'Dana', age: 29 });
    expect(result.attempts).toBe(1);
  });

  it('accepts JSON with raw newlines inside string fields', async () => {
    const multilineSchema = z.object({ content: z.string(), language: z.string() });
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"content":"Line 1\nLine 2","language":"en"}',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 16, totalTokens: 26 },
        finishReason: 'stop',
      })),
    });

    const result = await generateWithValidation(provider, { prompt: 'test json' }, multilineSchema);

    expect(result.data).toEqual({ content: 'Line 1\nLine 2', language: 'en' });
    expect(result.attempts).toBe(1);
  });

  it('throws after max retries exhausted', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"wrong":"schema"}',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      })),
    });

    await expect(
      generateWithValidation(provider, { prompt: 'test' }, schema, { maxRetries: 1 }),
    ).rejects.toThrow('AI output validation failed after 2 attempts');
  });

  it('does not retry incomplete provider outputs', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"name":"Alice"',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'length',
      })),
    });

    await expect(generateWithValidation(provider, { prompt: 'test json' }, schema)).rejects.toThrow(
      AIIncompleteOutputError,
    );
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('does not silently repair truncated JSON', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"name":"Alice","age":30',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      })),
    });

    await expect(
      generateWithValidation(provider, { prompt: 'test json' }, schema, { maxRetries: 0 }),
    ).rejects.toThrow('AI output validation failed after 1 attempts');
  });

  it('logs redacted JSON-shape diagnostics when structured parsing fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"name":"Alice","age":30',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      })),
    });

    await expect(
      generateWithValidation(
        provider,
        {
          prompt: 'test json',
          responseSchema: { type: 'object' },
          maxTokens: 400000,
        },
        schema,
        { maxRetries: 0, provider: 'mock-provider', model: 'mock-model' },
      ),
    ).rejects.toThrow('AI output validation failed after 1 attempts');

    const debugCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('/ingest/06cbeac8-a197-4896-9d68-c9e1a3d84ddc'),
    );
    expect(debugCall).toBeDefined();
    const debugBody = JSON.parse(String(debugCall?.[1]?.body));
    expect(debugBody.message).toBe('Structured response failed JSON parsing');
    expect(debugBody.data).toMatchObject({
      provider: 'mock-provider',
      model: 'mock-model',
      finishReason: 'stop',
      hasResponseSchema: true,
      maxTokens: 400000,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
    expect(debugBody.data.jsonShape).toMatchObject({
      contentLength: 24,
      startsWithObject: true,
      objectBalance: 1,
      endedInString: false,
    });
    expect(JSON.stringify(debugBody)).not.toContain('Alice');

    vi.unstubAllGlobals();
  });

  it('preserves the last raw output on validation failure', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"name":"Alice","age":30',
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      })),
    });

    let caught: unknown;
    try {
      await generateWithValidation(provider, { prompt: 'test json' }, schema, { maxRetries: 0 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AIValidationError);
    expect((caught as AIValidationError).attempts).toBe(1);
    expect((caught as AIValidationError).rawOutput).toBe('{"name":"Alice","age":30');
  });

  it('AIValidationError carries accumulated usage, model, and provider', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"bad":"shape"}',
        model: 'mock',
        usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15 },
        finishReason: 'stop',
      })),
    });

    let caught: unknown;
    try {
      await generateWithValidation(provider, { prompt: 'test json' }, schema, {
        maxRetries: 1,
        feedbackOnError: false,
        model: 'grok-4-fast-non-reasoning',
        provider: 'xai',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AIValidationError);
    const err = caught as AIValidationError;
    // Two attempts × 15 tokens = 30 accumulated
    expect(err.usage.totalTokens).toBe(30);
    expect(err.usage.inputTokens).toBe(14);
    expect(err.usage.outputTokens).toBe(16);
    expect(err.model).toBe('grok-4-fast-non-reasoning');
    expect(err.provider).toBe('xai');
  });

  it('AIValidationError defaults to provider.name when no explicit provider is threaded', async () => {
    const provider = createMockProvider({
      name: 'named-mock',
      complete: vi.fn(async () => ({
        content: '{"bad":"shape"}',
        model: 'mock',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      })),
    });

    let caught: unknown;
    try {
      await generateWithValidation(provider, { prompt: 'x json' }, schema, { maxRetries: 0 });
    } catch (error) {
      caught = error;
    }

    expect((caught as AIValidationError).provider).toBe('named-mock');
    expect((caught as AIValidationError).model).toBe('');
  });

  it('accumulates token usage across retries', async () => {
    let callCount = 0;
    const provider = createMockProvider({
      complete: vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            content: '{}',
            model: 'mock',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            finishReason: 'stop',
          };
        }
        return {
          content: '{"name":"Carl","age":40}',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: 'stop',
        };
      }),
    });

    const result = await generateWithValidation(provider, { prompt: 'test' }, schema, {
      maxRetries: 2,
    });

    expect(result.data).toEqual({ name: 'Carl', age: 40 });
    expect(result.attempts).toBe(3);
    expect(result.usage.totalTokens).toBe(60);
  });

  it('appends error feedback when feedbackOnError is true', async () => {
    const calls: string[] = [];
    const provider = createMockProvider({
      complete: vi.fn(async (req) => {
        calls.push(req.prompt);
        if (calls.length === 1) {
          return {
            content: '{}',
            model: 'mock',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            finishReason: 'stop',
          };
        }
        return {
          content: '{"name":"D","age":1}',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: 'stop',
        };
      }),
    });

    await generateWithValidation(provider, { prompt: 'original' }, schema, {
      maxRetries: 1,
      feedbackOnError: true,
    });

    expect(calls[1]).toContain('previous response was invalid');
  });

  it('auto-injects JSON instruction when prompt lacks "json"', async () => {
    const prompts: string[] = [];
    const provider = createMockProvider({
      complete: vi.fn(async (req) => {
        prompts.push(req.prompt);
        return {
          content: '{"name":"E","age":2}',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: 'stop',
        };
      }),
    });

    await generateWithValidation(provider, { prompt: 'Tell me about Alice' }, schema);

    expect(prompts[0]).toContain('Respond with a valid JSON object.');
  });

  it('does not inject JSON instruction when prompt already mentions json', async () => {
    const prompts: string[] = [];
    const provider = createMockProvider({
      complete: vi.fn(async (req) => {
        prompts.push(req.prompt);
        return {
          content: '{"name":"F","age":3}',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: 'stop',
        };
      }),
    });

    await generateWithValidation(provider, { prompt: 'Return the answer as json' }, schema);

    expect(prompts[0]).toBe('Return the answer as json');
    expect(prompts[0]).not.toContain('Respond with a valid JSON object.');
  });

  describe('with z.string() output schema', () => {
    it('uses responseFormat="text" and passes raw content through unwrapped', async () => {
      const stringSchema = z.string();
      const observed: Record<string, unknown>[] = [];
      const provider = createMockProvider({
        complete: vi.fn(async (req) => {
          observed.push(req as unknown as Record<string, unknown>);
          return {
            content: 'E|Childhood|1930|0.87||A description|||||||self|',
            model: 'mock',
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            finishReason: 'stop',
          };
        }),
      });

      const result = await generateWithValidation(
        provider,
        { prompt: 'Return pipe rows' },
        stringSchema,
      );

      expect(result.data).toBe('E|Childhood|1930|0.87||A description|||||||self|');
      expect(result.attempts).toBe(1);
      expect(observed[0]?.responseFormat).toBe('text');
    });

    it('does NOT inject the "Respond with a valid JSON object" hint when the schema is z.string()', async () => {
      const stringSchema = z.string();
      const prompts: string[] = [];
      const provider = createMockProvider({
        complete: vi.fn(async (req) => {
          prompts.push(req.prompt);
          return {
            content: 'some text',
            model: 'mock',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            finishReason: 'stop',
          };
        }),
      });

      await generateWithValidation(provider, { prompt: 'Say hi' }, stringSchema);

      expect(prompts[0]).toBe('Say hi');
      expect(prompts[0]).not.toContain('Respond with a valid JSON object.');
    });

    it('passes a raw pipe payload through even when it contains JSON-like braces', async () => {
      // Regression: the old code path ran JSON.parse on the content first,
      // so a pipe row containing `{}` would have thrown before reaching the
      // schema. With text mode we pass the raw string straight through.
      const stringSchema = z.string();
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: 'E|Event with {braces}|1950|0.5||{partial json} description|||||||self|',
          model: 'mock',
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          finishReason: 'stop',
        })),
      });

      const result = await generateWithValidation(
        provider,
        { prompt: 'Return pipe rows' },
        stringSchema,
      );

      expect(result.data).toContain('{braces}');
      expect(result.data).toContain('{partial json}');
    });

    it('still forces JSON mode for object schemas (backward compat)', async () => {
      // Ensures the string-output path is strictly additive: any non-string
      // schema (the common case) still gets responseFormat='json' and the
      // JSON auto-hint.
      const prompts: string[] = [];
      const observed: Record<string, unknown>[] = [];
      const provider = createMockProvider({
        complete: vi.fn(async (req) => {
          prompts.push(req.prompt);
          observed.push(req as unknown as Record<string, unknown>);
          return {
            content: '{"name":"Hi","age":1}',
            model: 'mock',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            finishReason: 'stop',
          };
        }),
      });

      await generateWithValidation(provider, { prompt: 'Tell me' }, schema);

      expect(observed[0]?.responseFormat).toBe('json');
      expect(prompts[0]).toContain('Respond with a valid JSON object.');
    });

    it('unwraps z.string().optional() and still uses text mode', async () => {
      const optionalString = z.string().optional();
      const observed: Record<string, unknown>[] = [];
      const provider = createMockProvider({
        complete: vi.fn(async (req) => {
          observed.push(req as unknown as Record<string, unknown>);
          return {
            content: 'raw text payload',
            model: 'mock',
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            finishReason: 'stop',
          };
        }),
      });

      const result = await generateWithValidation(provider, { prompt: 'Say hi' }, optionalString);

      expect(result.data).toBe('raw text payload');
      expect(observed[0]?.responseFormat).toBe('text');
    });
  });
});
