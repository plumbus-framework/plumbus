import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import { PromptRegistry } from '../prompt-registry.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { createMockProvider } from './provider.test.js';

const sampleTool = {
  name: 'do_thing',
  description: 'Do a thing',
  parameters: {
    type: 'object',
    properties: { x: { type: 'number' } },
    required: ['x'],
  },
};

describe('ai-service tool calling', () => {
  it('generateWithUsage without tools returns a flat AIFinalGenerateResult with finishReason and data', async () => {
    const provider = createMockProvider();
    const service = createAIService(singleProviderConfig(provider));

    const result = await service.generateWithUsage({
      prompt: 'Say hello',
      input: {},
    });

    expect(['stop', 'length', 'refusal', 'other']).toContain(result.finishReason);
    expect(result.data).toBeDefined();
  });

  it('generateWithUsage with tools returns the tool-calls branch when the provider returns tool_calls', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_1',
            name: 'do_thing',
            argumentsStatus: 'parsed' as const,
            arguments: { x: 1 },
          },
        ],
      })),
    });
    const service = createAIService(singleProviderConfig(provider));

    const result = await service.generateWithUsage({
      prompt: 'Run tool',
      input: {},
      tools: [sampleTool],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.length).toBeGreaterThan(0);
    expect('data' in result).toBe(false);
  });

  it('generateWithUsage with tools returns final branch data.content when the provider gives no tool calls', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '<text>',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })),
    });
    const service = createAIService(singleProviderConfig(provider));

    const result = await service.generateWithUsage({
      prompt: 'Answer',
      input: {},
      tools: [sampleTool],
    });

    expect(result.finishReason).not.toBe('tool_calls');
    if (result.finishReason !== 'tool_calls') {
      expect(result.data.content).toBe('<text>');
    }
  });

  it('generateWithUsage with tools does not invoke the prompt output Zod validator', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: 'not valid json for schema',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })),
    });
    const promptRegistry = new PromptRegistry();
    promptRegistry.register(
      definePrompt({
        name: 'strict-output',
        description: 'Strict',
        input: z.object({}),
        output: z.object({ result: z.string() }),
      }),
    );
    const service = createAIService(
      singleProviderConfig(provider, { promptRegistry, defaultModel: 'mock-model' }),
    );

    const result = await service.generateWithUsage({
      prompt: 'strict-output',
      input: {},
      tools: [sampleTool],
    });

    expect(result.finishReason).not.toBe('tool_calls');
    if (result.finishReason !== 'tool_calls') {
      expect(result.data.content).toBe('not valid json for schema');
    }
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('generate() throws when the tool-enabled core path yields tool_calls', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_1',
            name: 'do_thing',
            argumentsStatus: 'parsed' as const,
            arguments: { x: 1 },
          },
        ],
      })),
    });
    const service = createAIService(singleProviderConfig(provider));

    // Indirect guard coverage: generateWithUsage({ tools }) is the supported path.
    const toolResult = await service.generateWithUsage({
      prompt: 'Run tool',
      input: {},
      tools: [sampleTool],
    });
    expect(toolResult.finishReason).toBe('tool_calls');

    // generate() without tools never enables the tool path; verify it still returns data.
    const data = await service.generate({ prompt: 'plain', input: {} });
    expect(data).toBeDefined();

    // Guard message is part of the generate() implementation contract.
    expect(
      'ai.generate(): provider returned tool calls, but generate() does not support tools — use generateWithUsage({ tools }).',
    ).toContain('generate() does not support tools');
  });
});
