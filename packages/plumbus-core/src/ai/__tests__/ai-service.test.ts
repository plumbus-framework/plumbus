import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { definePrompt } from "../../define/definePrompt.js";
import { createAIService } from "../ai-service.js";
import { createCostTracker } from "../cost-tracker.js";
import { createExplainabilityTracker } from "../explainability.js";
import { PromptRegistry } from "../prompt-registry.js";
import { createInMemoryVectorStore, createRAGPipeline } from "../rag/pipeline.js";
import { createMockProvider } from "./provider.test.js";

describe("AI Service (ctx.ai)", () => {
  function setupService(opts?: {
    promptRegistry?: boolean;
    costTracker?: boolean;
    explainability?: boolean;
    rag?: boolean;
  }) {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"result":"hello"}',
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      })),
      embed: vi.fn(async (req) => ({
        embeddings: req.texts.map(() => [0.1, 0.2, 0.3]),
        model: "mock-embed",
        usage: { totalTokens: 5 },
      })),
    });

    const promptRegistry = opts?.promptRegistry ? new PromptRegistry() : undefined;
    const costTracker = opts?.costTracker ? createCostTracker() : undefined;
    const explainability = opts?.explainability ? createExplainabilityTracker() : undefined;

    let ragPipeline;
    if (opts?.rag) {
      const vectorStore = createInMemoryVectorStore();
      ragPipeline = createRAGPipeline({ provider, vectorStore });
    }

    const service = createAIService({
      provider,
      promptRegistry,
      costTracker,
      ragPipeline,
      defaultModel: "mock-model",
      budget: { tenantId: "t1", actor: "user1" },
    });

    return { service, provider, promptRegistry, costTracker, explainability };
  }

  describe("generate", () => {
    it("generates a response with raw prompt", async () => {
      const { service } = setupService();
      const result = await service.generate({
        prompt: "Say hello",
        input: {},
      });

      expect(result).toBe('{"result":"hello"}');
    });

    it("uses prompt registry when available", async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry!.register(
        definePrompt({
          name: "greet",
          description: "Say hello to {{name}}",
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
        }),
      );

      const result = await service.generate({
        prompt: "greet",
        input: { name: "Alice" },
      });

      expect(result).toEqual({ result: "hello" });
      expect(provider.complete).toHaveBeenCalled();
    });

    it("tracks cost when cost tracker is present", async () => {
      const { service, costTracker } = setupService({ costTracker: true });
      await service.generate({ prompt: "test", input: {} });

      expect(costTracker!.getRecords()).toHaveLength(1);
      expect(costTracker!.getRecords()[0]!.operation).toBe("generate");
    });
  });

  describe("extract", () => {
    it("extracts structured data from text", async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '{"name":"Alice","age":30}',
          model: "mock",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          finishReason: "stop",
        })),
      });

      const service = createAIService({ provider });
      const schema = z.object({ name: z.string(), age: z.number() });
      const result = await service.extract({ schema, text: "Alice is 30 years old" });

      expect(result).toEqual({ name: "Alice", age: 30 });
    });
  });

  describe("classify", () => {
    it("classifies text into labels", async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '["urgent","billing"]',
          model: "mock",
          usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
          finishReason: "stop",
        })),
      });

      const service = createAIService({ provider });
      const result = await service.classify({
        labels: ["urgent", "billing", "support"],
        text: "My payment failed and I need help now!",
      });

      expect(result).toEqual(["urgent", "billing"]);
    });

    it("filters out invalid labels", async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '["urgent","invalid_label"]',
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: "stop",
        })),
      });

      const service = createAIService({ provider });
      const result = await service.classify({
        labels: ["urgent", "billing"],
        text: "test",
      });

      expect(result).toEqual(["urgent"]);
    });
  });

  describe("retrieve", () => {
    it("throws when RAG pipeline not configured", async () => {
      const { service } = setupService();
      await expect(service.retrieve({ query: "test" })).rejects.toThrow(
        "RAG pipeline not configured",
      );
    });

    it("retrieves documents when RAG is configured", async () => {
      const { service } = setupService({ rag: true });

      // The in-memory store is empty so results will be empty, but it should not throw
      const results = await service.retrieve({ query: "test" });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("budget enforcement", () => {
    it("throws when budget is exceeded", async () => {
      const costTracker = createCostTracker({ dailyCostLimit: 0.001 });
      costTracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        estimatedCost: 0.001,
        latencyMs: 200,
      });

      const provider = createMockProvider();
      const service = createAIService({
        provider,
        costTracker,
        budget: { tenantId: "t1" },
      });

      await expect(
        service.generate({ prompt: "test", input: {} }),
      ).rejects.toThrow("AI budget exceeded");
    });
  });
});
