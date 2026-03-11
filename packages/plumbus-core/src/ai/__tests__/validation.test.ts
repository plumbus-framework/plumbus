import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateWithValidation } from "../validation.js";
import { createMockProvider } from "./provider.test.js";

describe("generateWithValidation", () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  it("returns validated data on first try", async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"name":"Alice","age":30}',
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      })),
    });

    const result = await generateWithValidation(provider, { prompt: "test" }, schema);

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.attempts).toBe(1);
    expect(result.usage.totalTokens).toBe(30);
  });

  it("retries on invalid JSON and succeeds", async () => {
    let callCount = 0;
    const provider = createMockProvider({
      complete: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "not json",
            model: "mock",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            finishReason: "stop",
          };
        }
        return {
          content: '{"name":"Bob","age":25}',
          model: "mock",
          usage: { inputTokens: 15, outputTokens: 20, totalTokens: 35 },
          finishReason: "stop",
        };
      }),
    });

    const result = await generateWithValidation(provider, { prompt: "test" }, schema);

    expect(result.data).toEqual({ name: "Bob", age: 25 });
    expect(result.attempts).toBe(2);
    expect(result.usage.totalTokens).toBe(50); // 15 + 35
  });

  it("throws after max retries exhausted", async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"wrong":"schema"}',
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: "stop",
      })),
    });

    await expect(
      generateWithValidation(provider, { prompt: "test" }, schema, { maxRetries: 1 }),
    ).rejects.toThrow("AI output validation failed after 2 attempts");
  });

  it("accumulates token usage across retries", async () => {
    let callCount = 0;
    const provider = createMockProvider({
      complete: vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            content: "{}",
            model: "mock",
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            finishReason: "stop",
          };
        }
        return {
          content: '{"name":"Carl","age":40}',
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: "stop",
        };
      }),
    });

    const result = await generateWithValidation(provider, { prompt: "test" }, schema, {
      maxRetries: 2,
    });

    expect(result.data).toEqual({ name: "Carl", age: 40 });
    expect(result.attempts).toBe(3);
    expect(result.usage.totalTokens).toBe(60);
  });

  it("appends error feedback when feedbackOnError is true", async () => {
    let calls: string[] = [];
    const provider = createMockProvider({
      complete: vi.fn(async (req) => {
        calls.push(req.prompt);
        if (calls.length === 1) {
          return {
            content: "{}",
            model: "mock",
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            finishReason: "stop",
          };
        }
        return {
          content: '{"name":"D","age":1}',
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: "stop",
        };
      }),
    });

    await generateWithValidation(provider, { prompt: "original" }, schema, {
      maxRetries: 1,
      feedbackOnError: true,
    });

    expect(calls[1]).toContain("previous response was invalid");
  });
});
