import { describe, expect, it, vi } from "vitest";
import {
    createAnthropicAdapter,
    createOpenAIAdapter,
    type AIProviderAdapter,
} from "../provider.js";

// ── Helper: create a mock provider ──
export function createMockProvider(
  overrides?: Partial<AIProviderAdapter>,
): AIProviderAdapter {
  return {
    name: "mock",
    complete: vi.fn(async () => ({
      content: '{"result": "test"}',
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    })),
    async *stream() {
      yield { type: "content_delta" as const, delta: "mock" };
      yield { type: "done" as const, finishReason: "stop" };
    },
    embed: vi.fn(async () => ({
      embeddings: [[0.1, 0.2, 0.3]],
      model: "mock-embed",
      usage: { totalTokens: 5 },
    })),
    ...overrides,
  };
}

describe("AI Provider Adapters", () => {
  describe("createOpenAIAdapter", () => {
    it("creates an adapter with name 'openai'", () => {
      const adapter = createOpenAIAdapter({ apiKey: "test-key" });
      expect(adapter.name).toBe("openai");
    });

    it("calls OpenAI chat completions endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
          model: "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: "sk-test" });
      const result = await adapter.complete({ prompt: "Say hello" });

      expect(result.content).toBe("Hello");
      expect(result.model).toBe("gpt-4o");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({ method: "POST" }),
      );

      vi.unstubAllGlobals();
    });

    it("sends system message when provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
          model: "gpt-4o",
          usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: "sk-test" });
      await adapter.complete({ prompt: "Hello", system: "Be nice" });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");

      vi.unstubAllGlobals();
    });

    it("throws on API error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          text: async () => "rate limited",
        }),
      );

      const adapter = createOpenAIAdapter({ apiKey: "sk-test" });
      await expect(adapter.complete({ prompt: "test" })).rejects.toThrow(
        "OpenAI API error (429)",
      );

      vi.unstubAllGlobals();
    });

    it("calls embeddings endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          model: "text-embedding-3-small",
          usage: { total_tokens: 8 },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: "sk-test" });
      const result = await adapter.embed({ texts: ["hello world"] });

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result.model).toBe("text-embedding-3-small");

      vi.unstubAllGlobals();
    });
  });

  describe("createAnthropicAdapter", () => {
    it("creates an adapter with name 'anthropic'", () => {
      const adapter = createAnthropicAdapter({ apiKey: "test-key" });
      expect(adapter.name).toBe("anthropic");
    });

    it("calls Anthropic messages endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Hello from Claude" }],
          model: "claude-sonnet-4-20250514",
          usage: { input_tokens: 10, output_tokens: 8 },
          stop_reason: "end_turn",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: "ant-test" });
      const result = await adapter.complete({ prompt: "Say hello" });

      expect(result.content).toBe("Hello from Claude");
      expect(result.usage.totalTokens).toBe(18);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-api-key": "ant-test" }),
        }),
      );

      vi.unstubAllGlobals();
    });

    it("throws on embed (unsupported)", async () => {
      const adapter = createAnthropicAdapter({ apiKey: "ant-test" });
      await expect(adapter.embed({ texts: ["hello"] })).rejects.toThrow(
        "Anthropic does not provide an embedding API",
      );
    });
  });
});
