import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateWithValidation } from '../validation.js';
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
});
