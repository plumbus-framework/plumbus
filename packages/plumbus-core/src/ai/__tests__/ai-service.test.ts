import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import type { AICostContext } from '../../types/context.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import type { AICostRecord, AICostRecordInput, CostTracker } from '../cost-tracker.js';
import { createCostTracker } from '../cost-tracker.js';
import { createExplainabilityTracker } from '../explainability.js';
import { PromptRegistry } from '../prompt-registry.js';
import type { AIProviderAdapter } from '../provider.js';
import { createInMemoryVectorStore, createRAGPipeline } from '../rag/pipeline.js';
import { AIIncompleteOutputError, AIRefusalError } from '../refusal.js';
import { createMockProvider } from './provider.test.js';

describe('AI Service (ctx.ai)', () => {
  function setupService(opts?: {
    promptRegistry?: boolean;
    costTracker?: boolean;
    explainability?: boolean;
    rag?: boolean;
    strictStructuredOutputs?: boolean;
  }) {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '{"result":"hello"}',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      })),
      embed: vi.fn(async (req) => ({
        embeddings: req.texts.map(() => [0.1, 0.2, 0.3]),
        model: 'mock-embed',
        usage: { totalTokens: 5 },
      })),
    });

    const promptRegistry = opts?.promptRegistry ? new PromptRegistry() : undefined;
    const costTracker = opts?.costTracker ? createCostTracker() : undefined;
    const explainability = opts?.explainability ? createExplainabilityTracker() : undefined;

    let ragPipeline: ReturnType<typeof createRAGPipeline> | undefined;
    if (opts?.rag) {
      const vectorStore = createInMemoryVectorStore();
      ragPipeline = createRAGPipeline({ provider, vectorStore });
    }

    const service = createAIService(
      singleProviderConfig(provider, {
        promptRegistry,
        costTracker,
        ragPipeline,
        defaultModel: 'mock-model',
        enableStrictStructuredOutputs: opts?.strictStructuredOutputs,
        budget: { tenantId: 't1', actor: 'user1' },
      }),
    );

    return { service, provider, promptRegistry, costTracker, explainability };
  }

  describe('generate', () => {
    it('generates a response with raw prompt', async () => {
      const { service } = setupService();
      const result = await service.generate({
        prompt: 'Say hello',
        input: {},
      });

      expect(result).toBe('{"result":"hello"}');
    });

    it('uses prompt registry when available', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'greet',
          description: 'Say hello to {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string(), language: z.string().optional() }),
        }),
      );

      const result = await service.generate({
        prompt: 'greet',
        input: { name: 'Alice' },
      });

      expect(result).toEqual({ result: 'hello' });
      expect(provider.complete).toHaveBeenCalled();
    });

    it('renders registered system prompts without duplicating substituted input', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'system-greet',
          system: 'You are {{role}}.',
          description: 'Data: {{text}}',
          input: z.object({
            role: z.string(),
            text: z.string(),
            locale: z.string(),
          }),
          output: z.object({ result: z.string(), language: z.string().optional() }),
        }),
      );

      await service.generate({
        prompt: 'system-greet',
        input: { role: 'editor', text: 'hello', locale: 'en' },
      });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are editor.',
          prompt: expect.stringContaining('Data: hello\n\nInput: {"locale":"en"}'),
        }),
      );
    });

    it('keeps system undefined for registered prompts without a system template', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'no-system',
          description: 'Data: {{text}}',
          input: z.object({ text: z.string() }),
          output: z.object({ result: z.string(), language: z.string().optional() }),
        }),
      );

      await service.generate({
        prompt: 'no-system',
        input: { text: 'hello' },
      });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          system: undefined,
          prompt: expect.stringContaining('Data: hello'),
        }),
      );
    });

    it('can omit unsubstituted input when a prompt renders the complete user message', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'complete-user-message',
          system: '{{systemInstructions}}',
          description: '{{userPrompt}}',
          input: z.object({
            systemInstructions: z.string(),
            userPrompt: z.string(),
            sourceText: z.string(),
          }),
          output: z.object({ result: z.string(), language: z.string().optional() }),
          appendUnsubstitutedInput: false,
        }),
      );

      await service.generate({
        prompt: 'complete-user-message',
        input: {
          systemInstructions: 'System text',
          userPrompt: 'User text',
          sourceText: 'raw source',
        },
      });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'System text',
          prompt: expect.stringContaining('User text'),
        }),
      );
    });

    it('passes a strict provider schema for registered JSON prompts when enabled', async () => {
      const { service, promptRegistry, provider } = setupService({
        promptRegistry: true,
        strictStructuredOutputs: true,
      });
      promptRegistry?.register(
        definePrompt({
          name: 'strict-greet',
          description: 'Say hello to {{name}} as JSON.',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string(), language: z.string().optional() }),
        }),
      );

      await service.generate({
        prompt: 'strict-greet',
        input: { name: 'Alice' },
      });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          responseFormat: 'json',
          responseSchema: expect.objectContaining({
            type: 'object',
            additionalProperties: false,
          }),
        }),
      );
    });

    it('does not add a prose JSON hint when provider schema is active', async () => {
      const { service, promptRegistry, provider } = setupService({
        promptRegistry: true,
        strictStructuredOutputs: true,
      });
      promptRegistry?.register(
        definePrompt({
          name: 'schema-only-extract',
          description: 'Extract names from {{text}}.',
          input: z.object({ text: z.string() }),
          output: z.object({ result: z.string(), language: z.string().optional() }),
          requireStrictStructuredOutputs: true,
        }),
      );

      await service.generate({
        prompt: 'schema-only-extract',
        input: { text: 'Alice and Bob' },
      });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          responseFormat: 'json',
          responseSchema: expect.objectContaining({ type: 'object' }),
          prompt: expect.not.stringContaining('Respond with a valid JSON object'),
        }),
      );
    });

    it('fails required strict structured prompts when provider schema is disabled', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'strict-required',
          description: 'Extract names from {{text}}.',
          input: z.object({ text: z.string() }),
          output: z.object({ names: z.array(z.string()) }),
          requireStrictStructuredOutputs: true,
        }),
      );

      await expect(
        service.generate({
          prompt: 'strict-required',
          input: { text: 'Alice and Bob' },
        }),
      ).rejects.toThrow('requires provider-side structured outputs');
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('does not pass a strict provider schema for prompt-level opt outs', async () => {
      const { service, promptRegistry, provider } = setupService({
        promptRegistry: true,
        strictStructuredOutputs: true,
      });
      promptRegistry?.register(
        definePrompt({
          name: 'legacy-json',
          description: 'Say hello as JSON.',
          input: z.object({}),
          output: z.object({ result: z.string() }),
          disableStrictStructuredOutputs: true,
        }),
      );

      await service.generate({ prompt: 'legacy-json', input: {} });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          responseFormat: 'json',
          responseSchema: undefined,
        }),
      );
    });

    it('tracks cost when cost tracker is present', async () => {
      const { service, costTracker } = setupService({ costTracker: true });
      await service.generate({ prompt: 'test', input: {} });

      expect(costTracker?.getRecords()).toHaveLength(1);
      expect(costTracker?.getRecords()[0]?.operation).toBe('generate');
    });

    it('records refused status and usage for provider refusals', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => {
          throw new AIRefusalError({
            provider: 'mock',
            model: 'mock-model',
            refusalText: 'No.',
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          });
        }),
      });
      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'refused',
          description: 'Return JSON.',
          input: z.object({}),
          output: z.object({ result: z.string() }),
        }),
      );
      const costTracker = createCostTracker();
      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry,
          costTracker,
          defaultModel: 'mock-model',
          enableStrictStructuredOutputs: true,
        }),
      );

      await expect(service.generate({ prompt: 'refused', input: {} })).rejects.toThrow(
        AIRefusalError,
      );
      expect(costTracker.getRecords()[0]).toMatchObject({
        status: 'refused',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
    });

    it('records incomplete status and usage for truncated structured outputs', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => {
          throw new AIIncompleteOutputError({
            provider: 'mock',
            model: 'mock-model',
            partialText: '{"result":',
            usage: { inputTokens: 3, outputTokens: 8, totalTokens: 11 },
            finishReason: 'length',
          });
        }),
      });
      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'truncated',
          description: 'Return JSON.',
          input: z.object({}),
          output: z.object({ result: z.string() }),
        }),
      );
      const costTracker = createCostTracker();
      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry,
          costTracker,
          defaultModel: 'mock-model',
          enableStrictStructuredOutputs: true,
        }),
      );

      await expect(service.generate({ prompt: 'truncated', input: {} })).rejects.toThrow(
        AIIncompleteOutputError,
      );
      expect(costTracker.getRecords()[0]).toMatchObject({
        status: 'incomplete',
        usage: { inputTokens: 3, outputTokens: 8, totalTokens: 11 },
      });
    });
  });

  describe('prompt assembly', () => {
    function getRequestPrompt(provider: AIProviderAdapter): string {
      const mock = provider.complete as unknown as { mock: { calls: unknown[][] } };
      const firstCall = mock.mock.calls[0];
      const req = firstCall?.[0] as { prompt?: string } | undefined;
      return req?.prompt ?? '';
    }

    it('does NOT append `Input: {...}` when every input key is consumed by a {{placeholder}}', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'all-substituted',
          description: 'Hello {{name}}, you are {{age}} years old. Respond as JSON.',
          input: z.object({ name: z.string(), age: z.number() }),
          output: z.object({ result: z.string() }),
        }),
      );

      await service.generate({
        prompt: 'all-substituted',
        input: { name: 'Alice', age: 30 },
      });

      const sent = getRequestPrompt(provider);
      expect(sent).toContain('Hello Alice, you are 30 years old');
      expect(sent).not.toContain('Input: {');
      // Each substituted value should appear exactly once (no duplication)
      expect(sent.match(/Alice/g)?.length ?? 0).toBe(1);
      expect(sent.match(/\b30\b/g)?.length ?? 0).toBe(1);
    });

    it('appends only the unsubstituted keys when input has extras beyond the placeholders', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'partial-substituted',
          description: 'Greet {{name}}. Respond as JSON.',
          input: z.object({ name: z.string(), context: z.string() }),
          output: z.object({ result: z.string() }),
        }),
      );

      await service.generate({
        prompt: 'partial-substituted',
        input: { name: 'Alice', context: 'morning meeting' },
      });

      const sent = getRequestPrompt(provider);
      expect(sent).toContain('Greet Alice');
      expect(sent).toContain('Input: {');
      expect(sent).toContain('"context":"morning meeting"');
      expect(sent).not.toContain('"name":"Alice"');
      // Substituted value still appears only once (in the rendered template, not in Input blob)
      expect(sent.match(/Alice/g)?.length ?? 0).toBe(1);
    });

    it('appends Input: {...} when prompt has no placeholders for any input key', async () => {
      const { service, promptRegistry, provider } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'no-placeholders',
          description: 'Process the input. Respond as JSON.',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
        }),
      );

      await service.generate({
        prompt: 'no-placeholders',
        input: { name: 'Alice' },
      });

      const sent = getRequestPrompt(provider);
      expect(sent).toContain('Process the input.');
      expect(sent).toContain('Input: {"name":"Alice"}');
    });

    it('raw-prompt path (no registry def) is unchanged: no Input append, prompt sent as-is', async () => {
      const { service, provider } = setupService();
      await service.generate({ prompt: 'just say hi', input: {} });

      const sent = getRequestPrompt(provider);
      expect(sent).toBe('just say hi');
    });
  });

  describe('generateWithUsage', () => {
    it('returns data and usage for raw prompt', async () => {
      const { service } = setupService();
      const result = await service.generateWithUsage({
        prompt: 'Say hello',
        input: {},
      });

      expect(result.data).toBe('{"result":"hello"}');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    });

    it('returns validated data and usage with prompt registry', async () => {
      const { service, promptRegistry } = setupService({ promptRegistry: true });
      promptRegistry?.register(
        definePrompt({
          name: 'greet',
          description: 'Say hello to {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
        }),
      );

      const result = await service.generateWithUsage({
        prompt: 'greet',
        input: { name: 'Alice' },
      });

      expect(result.data).toEqual({ result: 'hello' });
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(20);
    });

    it('allows per-request validation overrides', async () => {
      let callCount = 0;
      const provider = createMockProvider({
        complete: vi.fn(async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: '{"wrong":"schema"}',
              model: 'mock-model',
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              finishReason: 'stop',
            };
          }

          return {
            content: '{"result":"hello"}',
            model: 'mock-model',
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            finishReason: 'stop',
          };
        }),
      });

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'greet-once',
          description: 'Say hello once',
          input: z.object({}),
          output: z.object({ result: z.string() }),
        }),
      );

      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry,
          defaultModel: 'mock-model',
        }),
      );

      await expect(
        service.generateWithUsage({
          prompt: 'greet-once',
          input: {},
          validation: { maxRetries: 0, feedbackOnError: false },
        }),
      ).rejects.toThrow('AI output validation failed after 1 attempts');

      expect(provider.complete).toHaveBeenCalledTimes(1);
    });
  });

  describe('extract', () => {
    it('extracts structured data from text', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '{"name":"Alice","age":30}',
          model: 'mock',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          finishReason: 'stop',
        })),
      });

      const service = createAIService(singleProviderConfig(provider));
      const schema = z.object({ name: z.string(), age: z.number() });
      const result = await service.extract({ schema, text: 'Alice is 30 years old' });

      expect(result).toEqual({ name: 'Alice', age: 30 });
    });
  });

  describe('classify', () => {
    it('classifies text into labels', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '["urgent","billing"]',
          model: 'mock',
          usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
          finishReason: 'stop',
        })),
      });

      const service = createAIService(singleProviderConfig(provider));
      const result = await service.classify({
        labels: ['urgent', 'billing', 'support'],
        text: 'My payment failed and I need help now!',
      });

      expect(result).toEqual(['urgent', 'billing']);
    });

    it('filters out invalid labels', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '["urgent","invalid_label"]',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        })),
      });

      const service = createAIService(singleProviderConfig(provider));
      const result = await service.classify({
        labels: ['urgent', 'billing'],
        text: 'test',
      });

      expect(result).toEqual(['urgent']);
    });
  });

  describe('retrieve', () => {
    it('throws when RAG pipeline not configured', async () => {
      const { service } = setupService();
      await expect(service.retrieve({ query: 'test' })).rejects.toThrow(
        'RAG pipeline not configured',
      );
    });

    it('retrieves documents when RAG is configured', async () => {
      const { service } = setupService({ rag: true });

      // The in-memory store is empty so results will be empty, but it should not throw
      const results = await service.retrieve({ query: 'test' });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('budget enforcement', () => {
    it('throws when budget is exceeded', async () => {
      const costTracker = createCostTracker({ dailyCostLimit: 0.001 });
      costTracker.record({
        model: 'gpt-4o',
        provider: 'mock',
        operation: 'generate',
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        cost: 0.001,
        latencyMs: 200,
      });

      const provider = createMockProvider();
      const service = createAIService(
        singleProviderConfig(provider, {
          costTracker,
          budget: { tenantId: 't1' },
        }),
      );

      await expect(service.generate({ prompt: 'test', input: {} })).rejects.toThrow(
        'AI budget exceeded',
      );
    });
  });

  describe('multi-provider routing', () => {
    function createNamedProvider(name: string, content = '{"result":"ok"}'): AIProviderAdapter {
      return createMockProvider({
        name,
        complete: vi.fn(async () => ({
          content,
          model: `${name}-model`,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          finishReason: 'stop',
        })),
      });
    }

    it('routes to the prompt-specified provider', async () => {
      const openai = createNamedProvider('openai', '{"result":"from-openai"}');
      const anthropic = createNamedProvider('anthropic', '{"result":"from-anthropic"}');

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'write-bio',
          description: 'Write a bio for {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
          model: { name: 'claude-sonnet', provider: 'anthropic' },
        }),
      );

      const service = createAIService({
        providers: { openai, anthropic },
        defaultProvider: 'openai',
        promptRegistry,
      });

      await service.generate({ prompt: 'write-bio', input: { name: 'Alice' } });

      expect(anthropic.complete).toHaveBeenCalled();
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('falls back to default provider when prompt has no provider', async () => {
      const openai = createNamedProvider('openai');
      const anthropic = createNamedProvider('anthropic');

      const service = createAIService({
        providers: { openai, anthropic },
        defaultProvider: 'openai',
      });

      await service.generate({ prompt: 'raw prompt', input: {} });

      expect(openai.complete).toHaveBeenCalled();
      expect(anthropic.complete).not.toHaveBeenCalled();
    });

    it('throws when prompt specifies an unknown provider', async () => {
      const openai = createNamedProvider('openai');

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'failing',
          description: 'This will fail',
          input: z.object({}),
          output: z.object({ result: z.string() }),
          model: { name: 'some-model', provider: 'nonexistent' },
        }),
      );

      const service = createAIService({
        providers: { openai },
        defaultProvider: 'openai',
        promptRegistry,
      });

      await expect(service.generate({ prompt: 'failing', input: {} })).rejects.toThrow(
        'AI provider "nonexistent" not configured',
      );
    });

    it('records provider name in cost tracker entries', async () => {
      const anthropic = createNamedProvider('anthropic');
      const costTracker = createCostTracker();

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'tracked',
          description: 'Tracked prompt',
          input: z.object({}),
          output: z.object({ result: z.string() }),
          model: { name: 'claude-sonnet', provider: 'anthropic' },
        }),
      );

      const service = createAIService({
        providers: { anthropic },
        defaultProvider: 'anthropic',
        promptRegistry,
        costTracker,
      });

      await service.generate({ prompt: 'tracked', input: {} });

      const records = costTracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe('anthropic');
    });

    it('extract and classify use default provider', async () => {
      const openai = createNamedProvider('openai', '{"name":"Alice","age":30}');
      const anthropic = createNamedProvider('anthropic');

      const service = createAIService({
        providers: { openai, anthropic },
        defaultProvider: 'openai',
      });

      const schema = z.object({ name: z.string(), age: z.number() });
      await service.extract({ schema, text: 'Alice is 30' });

      expect(openai.complete).toHaveBeenCalled();
      expect(anthropic.complete).not.toHaveBeenCalled();
    });
  });

  describe('prompt override resolution', () => {
    function createNamedProvider(name: string, content = '{"result":"ok"}'): AIProviderAdapter {
      return createMockProvider({
        name,
        complete: vi.fn(async () => ({
          content,
          model: `${name}-model`,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          finishReason: 'stop',
        })),
      });
    }

    it('uses promptOverrides to route to a different provider', async () => {
      const openai = createNamedProvider('openai');
      const anthropic = createNamedProvider('anthropic', '{"result":"from-anthropic"}');

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'write-bio',
          description: 'Write a bio for {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
          model: { name: 'gpt-4o', provider: 'openai' },
        }),
      );

      const service = createAIService({
        providers: { openai, anthropic },
        defaultProvider: 'openai',
        promptRegistry,
        promptOverrides: {
          'write-bio': { provider: 'anthropic', model: 'claude-sonnet' },
        },
      });

      await service.generate({ prompt: 'write-bio', input: { name: 'Alice' } });

      expect(anthropic.complete).toHaveBeenCalled();
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('uses promptOverrides model over prompt-defined model', async () => {
      const openai = createNamedProvider('openai');

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'write-bio',
          description: 'Write a bio for {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
          model: { name: 'gpt-4o', provider: 'openai' },
        }),
      );

      const service = createAIService({
        providers: { openai },
        defaultProvider: 'openai',
        promptRegistry,
        promptOverrides: {
          'write-bio': { model: 'gpt-4o-mini' },
        },
      });

      await service.generate({ prompt: 'write-bio', input: { name: 'Alice' } });

      const call = (openai.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(call?.model).toBe('gpt-4o-mini');
    });

    it('falls back to defaultModel when neither override nor prompt defines model', async () => {
      const openai = createNamedProvider('openai');

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'simple',
          description: 'A simple prompt',
          input: z.object({}),
          output: z.object({ result: z.string() }),
        }),
      );

      const service = createAIService({
        providers: { openai },
        defaultProvider: 'openai',
        promptRegistry,
        defaultModel: 'gpt-4o-mini',
      });

      await service.generate({ prompt: 'simple', input: {} });

      const call = (openai.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(call?.model).toBe('gpt-4o-mini');
    });

    it('uses prompt model when no override is specified', async () => {
      const openai = createNamedProvider('openai');

      const promptRegistry = new PromptRegistry();
      promptRegistry.register(
        definePrompt({
          name: 'write-bio',
          description: 'Write a bio for {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
          model: { name: 'gpt-4o', provider: 'openai' },
        }),
      );

      const service = createAIService({
        providers: { openai },
        defaultProvider: 'openai',
        promptRegistry,
        defaultModel: 'fallback-model',
      });

      await service.generate({ prompt: 'write-bio', input: { name: 'Alice' } });

      const call = (openai.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(call?.model).toBe('gpt-4o');
    });
  });

  // ── Failure-path cost recording + onAICostRecorded hook ──
  describe('failure-path cost recording', () => {
    function makePromptRegistry(): PromptRegistry {
      const reg = new PromptRegistry();
      reg.register(
        definePrompt({
          name: 'greet',
          description: 'Say hello to {{name}}',
          input: z.object({ name: z.string() }),
          output: z.object({ result: z.string() }),
        }),
      );
      return reg;
    }

    it('records status=success on the happy path with onAICostRecorded', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '{"result":"hi"}',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        })),
      });
      const costTracker = createCostTracker();
      const hookCalls: Array<{ record: AICostRecord; ctx: AICostContext | undefined }> = [];

      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry: makePromptRegistry(),
          costTracker,
          defaultModel: 'mock-model',
          onAICostRecorded: (record, ctx) => {
            hookCalls.push({ record, ctx });
          },
        }),
      );

      await service.generate({
        prompt: 'greet',
        input: { name: 'Alice' },
        costContext: { projectId: 'p1', operationName: 'test' },
      });

      expect(costTracker.getRecords()).toHaveLength(1);
      expect(costTracker.getRecords()[0]?.status).toBe('success');
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]?.record.status).toBe('success');
      expect(hookCalls[0]?.ctx).toEqual({ projectId: 'p1', operationName: 'test' });
    });

    it('records status=failed with AIValidationError.usage when validation exhausts retries', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '{"wrong":"schema"}',
          model: 'mock',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          finishReason: 'stop',
        })),
      });
      const costTracker = createCostTracker();
      const hookCalls: Array<{ record: AICostRecord; ctx: AICostContext | undefined }> = [];

      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry: makePromptRegistry(),
          costTracker,
          defaultModel: 'mock-model',
          onAICostRecorded: (record, ctx) => {
            hookCalls.push({ record, ctx });
          },
        }),
      );

      await expect(
        service.generate({
          prompt: 'greet',
          input: { name: 'Alice' },
          validation: { maxRetries: 1, feedbackOnError: false },
          costContext: { projectId: 'p2' },
        }),
      ).rejects.toThrow(/AI output validation failed/);

      expect(costTracker.getRecords()).toHaveLength(1);
      const record = costTracker.getRecords()[0];
      expect(record?.status).toBe('failed');
      // Two attempts × 20 tokens each = 40 accumulated via AIValidationError.usage
      expect(record?.usage.totalTokens).toBe(40);
      expect(record?.errorMessage).toMatch(/validation/i);
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]?.record.status).toBe('failed');
      expect(hookCalls[0]?.ctx).toEqual({ projectId: 'p2' });
    });

    it('records status=failed with zero usage when provider throws an opaque error', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => {
          throw new Error('Headers Timeout Error');
        }),
      });
      const costTracker = createCostTracker();

      const service = createAIService(
        singleProviderConfig(provider, {
          costTracker,
          defaultModel: 'mock-model',
        }),
      );

      await expect(service.generate({ prompt: 'just a raw prompt', input: {} })).rejects.toThrow(
        'Headers Timeout Error',
      );

      const records = costTracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('failed');
      expect(records[0]?.usage.totalTokens).toBe(0);
      expect(records[0]?.errorMessage).toContain('Headers Timeout Error');
    });

    it('streamGenerate records status=failed on mid-stream transport error', async () => {
      const provider: AIProviderAdapter = {
        name: 'mock',
        complete: vi.fn(),
        async *stream() {
          yield { type: 'content_delta' as const, delta: '' };
          throw new Error('socket hang up');
        },
        embed: vi.fn(),
      };
      const costTracker = createCostTracker();

      const service = createAIService(
        singleProviderConfig(provider, {
          costTracker,
          defaultModel: 'mock-model',
        }),
      );

      const iterator = service.streamGenerate({ prompt: 'test', input: {} });
      await expect(async () => {
        for await (const _ of iterator) {
          // drain
        }
      }).rejects.toThrow('socket hang up');

      const records = costTracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('failed');
      expect(records[0]?.errorMessage).toContain('socket hang up');
    });

    it('streamGenerate records status=failed with combined stream+fallback usage on fallback validation failure', async () => {
      const reg = new PromptRegistry();
      reg.register(
        definePrompt({
          name: 'structured',
          description: 'Return json',
          input: z.object({}),
          output: z.object({ ok: z.boolean(), name: z.string() }),
        }),
      );
      const stream = vi.fn().mockImplementation(async function* () {
        // Emit malformed JSON so local parse fails and we fall back
        yield { type: 'content_delta' as const, delta: '{"ok":' };
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      });
      const complete = vi.fn(async () => ({
        content: '{"still":"wrong"}',
        model: 'mock',
        usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
        finishReason: 'stop',
      }));
      const provider: AIProviderAdapter = {
        name: 'mock',
        complete,
        stream,
        embed: vi.fn(),
      };
      const costTracker = createCostTracker();

      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry: reg,
          costTracker,
          defaultModel: 'mock-model',
          validation: { maxRetries: 0, feedbackOnError: false },
        }),
      );

      const iterator = service.streamGenerate({ prompt: 'structured', input: {} });
      await expect(async () => {
        for await (const _ of iterator) {
          // drain
        }
      }).rejects.toThrow(/AI output validation failed/);

      const records = costTracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('failed');
      // streamUsage (105) + fallback validation usage (55) = 160 total
      expect(records[0]?.usage.totalTokens).toBe(160);
      expect(records[0]?.usage.inputTokens).toBe(150);
      expect(records[0]?.usage.outputTokens).toBe(10);
    });

    it('onAICostRecorded hook errors are swallowed and do not break the AI call', async () => {
      const provider = createMockProvider({
        complete: vi.fn(async () => ({
          content: '{"result":"ok"}',
          model: 'mock',
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          finishReason: 'stop',
        })),
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const service = createAIService(
        singleProviderConfig(provider, {
          promptRegistry: makePromptRegistry(),
          defaultModel: 'mock-model',
          onAICostRecorded: () => {
            throw new Error('hook boom');
          },
        }),
      );

      const result = await service.generate({ prompt: 'greet', input: { name: 'Alice' } });
      expect(result).toEqual({ result: 'ok' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('hook boom'));
      consoleSpy.mockRestore();
    });
  });

  // ── Text-mode brevity-hint suffix (and its opt-out) ──
  // The ai-service auto-detects single-string-field output schemas
  // (e.g. z.object({ content: z.string() })) and switches to plain text
  // mode while appending a brevity-hint suffix that tells the model to
  // "Respond with ONLY the plain text content...". That hint is the right
  // default for short Q&A but collapses long-form prose into bullet points
  // on some models — so prompts can opt out via
  // `disableTextModeBrevityHint: true`.
  describe('text-mode brevity hint', () => {
    function makeStreamSpy() {
      return vi.fn().mockImplementation(async function* () {
        yield { type: 'content_delta' as const, delta: 'short body' };
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      });
    }

    function getStreamRequest(streamSpy: ReturnType<typeof vi.fn>): {
      system?: string;
      prompt?: string;
      responseFormat?: string;
    } {
      const firstCall = streamSpy.mock.calls[0] as unknown[] | undefined;
      const req = firstCall?.[0] as
        | { system?: string; prompt?: string; responseFormat?: string }
        | undefined;
      return req ?? {};
    }

    async function drain<T>(iter: AsyncIterable<T>): Promise<void> {
      for await (const _ of iter) {
        // drain
      }
    }

    it('default text-mode (single string field, no opt-out): appends brevity-hint suffix', async () => {
      const streamSpy = makeStreamSpy();
      const provider: AIProviderAdapter = {
        name: 'mock',
        complete: vi.fn(),
        stream: streamSpy,
        embed: vi.fn(),
      };
      const reg = new PromptRegistry();
      reg.register(
        definePrompt({
          name: 'qa',
          description: 'Answer the question.',
          input: z.object({}),
          output: z.object({ content: z.string() }),
        }),
      );
      const service = createAIService(
        singleProviderConfig(provider, { promptRegistry: reg, defaultModel: 'mock-model' }),
      );

      await drain(service.streamGenerate({ prompt: 'qa', input: {} }));

      const req = getStreamRequest(streamSpy);
      expect(req.prompt ?? '').toContain('Respond with ONLY the plain text content');
      expect(req.responseFormat).toBe('text');
    });

    it('forwards registered system prompts on streaming calls', async () => {
      const streamSpy = makeStreamSpy();
      const provider: AIProviderAdapter = {
        name: 'mock',
        complete: vi.fn(),
        stream: streamSpy,
        embed: vi.fn(),
      };
      const reg = new PromptRegistry();
      reg.register(
        definePrompt({
          name: 'stream-system',
          system: 'You are {{role}}.',
          description: 'Write about {{topic}}',
          input: z.object({
            role: z.string(),
            topic: z.string(),
            locale: z.string(),
          }),
          output: z.object({ content: z.string() }),
          disableTextModeBrevityHint: true,
        }),
      );
      const service = createAIService(
        singleProviderConfig(provider, { promptRegistry: reg, defaultModel: 'mock-model' }),
      );

      await drain(
        service.streamGenerate({
          prompt: 'stream-system',
          input: { role: 'editor', topic: 'Baghdad', locale: 'he' },
        }),
      );

      const req = getStreamRequest(streamSpy);
      expect(req.system).toBe('You are editor.');
      expect(req.prompt).toBe('Write about Baghdad\n\nInput: {"locale":"he"}');
      expect(req.responseFormat).toBe('text');
    });

    it('text-mode with disableTextModeBrevityHint=true: omits brevity-hint suffix but stays in text mode', async () => {
      const streamSpy = makeStreamSpy();
      const provider: AIProviderAdapter = {
        name: 'mock',
        complete: vi.fn(),
        stream: streamSpy,
        embed: vi.fn(),
      };
      const reg = new PromptRegistry();
      reg.register(
        definePrompt({
          name: 'long-form',
          description: 'Write a long chapter. Output the title on the first line as a markdown H1.',
          input: z.object({}),
          output: z.object({ content: z.string() }),
          disableTextModeBrevityHint: true,
        }),
      );
      const service = createAIService(
        singleProviderConfig(provider, { promptRegistry: reg, defaultModel: 'mock-model' }),
      );

      await drain(service.streamGenerate({ prompt: 'long-form', input: {} }));

      const req = getStreamRequest(streamSpy);
      const sent = req.prompt ?? '';
      expect(sent).not.toContain('Respond with ONLY the plain text content');
      expect(sent).not.toContain('Do NOT wrap your response in JSON');
      // Body must still be there — only the appended suffix is suppressed
      expect(sent).toContain('Write a long chapter');
      // And we are still in text mode (the whole point of the opt-out is to
      // keep the streamed payload as raw text so JSON-escape rules never
      // apply — e.g. for Hebrew content with embedded gershayim).
      expect(req.responseFormat).toBe('text');
    });

    it('json-mode (multi-field schema) is unaffected by the opt-out flag: JSON instruction still appended', async () => {
      const streamSpy = vi.fn().mockImplementation(async function* () {
        yield { type: 'content_delta' as const, delta: '{"a":"x","b":"y"}' };
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      });
      const provider: AIProviderAdapter = {
        name: 'mock',
        complete: vi.fn(),
        stream: streamSpy,
        embed: vi.fn(),
      };
      const reg = new PromptRegistry();
      reg.register(
        definePrompt({
          name: 'multi',
          description: 'Return two fields.',
          input: z.object({}),
          output: z.object({ a: z.string(), b: z.string() }),
          // Even with the flag set, multi-field schemas are not text-mode
          // candidates, so this flag is a no-op for them.
          disableTextModeBrevityHint: true,
        }),
      );
      const service = createAIService(
        singleProviderConfig(provider, { promptRegistry: reg, defaultModel: 'mock-model' }),
      );

      await drain(service.streamGenerate({ prompt: 'multi', input: {} }));

      const req = getStreamRequest(streamSpy);
      expect(req.responseFormat).toBe('json');
      expect(req.prompt ?? '').toContain('Respond with a valid JSON object');
      // And the text-mode hint is definitely NOT in a JSON-mode call.
      expect(req.prompt ?? '').not.toContain('Respond with ONLY the plain text content');
    });
  });

  // ── Backward-compat: record() input type keeps `status` optional ──
  describe('CostTracker backward-compat', () => {
    it('record(entry) without status still compiles and defaults to success', () => {
      // This test's real value is type-level: if `status` stops being
      // optional on AICostRecordInput, this file fails to compile and
      // every external consumer of CostTracker.record breaks.
      const tracker = createCostTracker();
      const entry: AICostRecordInput = {
        model: 'm',
        provider: 'p',
        operation: 'generate',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        cost: null,
        latencyMs: 0,
      };
      tracker.record(entry);
      expect(tracker.getRecords()).toHaveLength(1);
      expect(tracker.getRecords()[0]?.status).toBe('success');
    });

    it('a consumer-supplied CostTracker mock without status handling still satisfies the interface', () => {
      // Consumers writing their own tracker mocks (e.g. in framework tests)
      // should not have to know about the new `status` field.
      const seen: AICostRecordInput[] = [];
      const tracker: CostTracker = {
        record(entry) {
          seen.push(entry);
        },
        checkBudget() {
          return { allowed: true };
        },
        getDailyUsage() {
          return { totalTokens: 0, totalCost: 0, costAvailable: false, requestCount: 0 };
        },
        getRecords() {
          return [];
        },
      };
      tracker.record({
        model: 'm',
        provider: 'p',
        operation: 'generate',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        cost: null,
        latencyMs: 0,
      });
      expect(seen).toHaveLength(1);
    });
  });
});
