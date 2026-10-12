import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AIServiceConfig, createAIService } from '../../ai/ai-service.js';
import type { AIProviderAdapter, ProviderRequest } from '../../ai/provider.js';
import { loadPromptOverrides } from '../../config/loader.js';
import { definePrompt } from '../../define/definePrompt.js';
import { type ServerConfig, wrapAIServiceWithDynamicOverrides } from '../bootstrap.js';

/** A prompt that pins its own model fields, so every override layer has something to beat. */
const summarize = definePrompt({
  name: 'report.summarize',
  description: 'Summarize the text',
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  model: { name: 'gpt-4o', temperature: 0.2, maxTokens: 64_000, timeoutMs: 900_000 },
});

/** A prompt whose definition asks for reasoning. */
const reasoned = definePrompt({
  name: 'report.reason',
  description: 'Summarize the text',
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  model: { reasoning: { mode: 'effort', effort: 'high' } },
});

/** A prompt that names no model or provider, so the defaults decide. */
const plain = definePrompt({
  name: 'plain',
  description: 'Summarize the text',
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
});

function recordingProvider(name: string): AIProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    name,
    requests,
    async complete(request) {
      requests.push(request);
      return {
        content: '{"summary":"s"}',
        model: request.model ?? 'unknown',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
    async *stream() {
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async embed() {
      return { embeddings: [], model: 'embed', usage: { totalTokens: 0 } };
    },
  };
}

type Resolved = Awaited<ReturnType<NonNullable<ServerConfig['resolveAiOverrides']>>>;

/**
 * A service wired the way the HTTP server and the worker pool wire it: env `PROMPT_{NAME}_*`
 * overrides in `promptOverrides`, wrapped with a `resolveAiOverrides` answering `answers` in turn
 * (the last one repeats).
 */
function wiredService(env: Record<string, string>, ...answers: Resolved[]) {
  const openai = recordingProvider('openai');
  const anthropic = recordingProvider('anthropic');
  const config: AIServiceConfig = {
    providers: { openai, anthropic },
    defaultProvider: 'openai',
    defaultModel: 'configured-default',
    prompts: [summarize, plain, reasoned],
    promptOverrides: loadPromptOverrides(env),
  };
  let call = 0;
  const ai = wrapAIServiceWithDynamicOverrides(
    createAIService(config),
    config,
    async () => answers[Math.min(call++, answers.length - 1)] ?? {},
    {} as never,
  );
  return { ai, openai, anthropic };
}

const input = { text: 't' };

describe('resolveAiOverrides over PROMPT_{NAME}_* env overrides', () => {
  it('keeps the env MAX_TOKENS, TIMEOUT_MS and TEMPERATURE when the dynamic override sets only the model', async () => {
    const { ai, openai } = wiredService(
      {
        PROMPT_REPORT_SUMMARIZE_MAX_TOKENS: '321',
        PROMPT_REPORT_SUMMARIZE_TIMEOUT_MS: '50000',
        PROMPT_REPORT_SUMMARIZE_TEMPERATURE: '0.7',
      },
      { promptOverrides: { report_summarize: { model: 'gpt-4.1-mini' } } },
    );

    await ai.generateWithUsage({ prompt: 'report.summarize', input });

    expect(openai.requests[0]).toMatchObject({
      model: 'gpt-4.1-mini',
      maxTokens: 321,
      timeout: 50_000,
      temperature: 0.7,
    });
  });

  it('lets each field the dynamic override sets win over the env one', async () => {
    const { ai, openai } = wiredService(
      { PROMPT_REPORT_SUMMARIZE_MODEL: 'gpt-4o-mini', PROMPT_REPORT_SUMMARIZE_MAX_TOKENS: '321' },
      { promptOverrides: { report_summarize: { maxTokens: 222, timeoutMs: 1_000 } } },
    );

    await ai.generateWithUsage({ prompt: 'report.summarize', input });

    expect(openai.requests[0]).toMatchObject({
      model: 'gpt-4o-mini',
      maxTokens: 222,
      timeout: 1_000,
      temperature: 0.2,
    });
  });

  it("applies a dynamic override keyed by the prompt's name over the env override", async () => {
    const { ai, openai } = wiredService(
      { PROMPT_REPORT_SUMMARIZE_MODEL: 'gpt-4o-mini' },
      { promptOverrides: { 'report.summarize': { model: 'gpt-4.1-mini' } } },
    );

    await ai.generateWithUsage({ prompt: 'report.summarize', input });

    expect(openai.requests[0]?.model).toBe('gpt-4.1-mini');
  });

  it('lets per-call values win over the dynamic and env overrides', async () => {
    const { ai, openai, anthropic } = wiredService(
      { PROMPT_REPORT_SUMMARIZE_MODEL: 'gpt-4o-mini', PROMPT_REPORT_SUMMARIZE_TIMEOUT_MS: '50000' },
      {
        promptOverrides: {
          'report.summarize': { provider: 'anthropic', model: 'claude-x', timeoutMs: 1_000 },
        },
      },
    );

    await ai.generateWithUsage({
      prompt: 'report.summarize',
      input,
      provider: 'openai',
      model: 'per-call',
      timeoutMs: 2_000,
    });

    expect(anthropic.requests).toHaveLength(0);
    expect(openai.requests[0]).toMatchObject({ model: 'per-call', timeout: 2_000 });
  });

  it('applies the same layers in a service bound with withContext', async () => {
    const { ai, openai } = wiredService(
      { PROMPT_REPORT_SUMMARIZE_MAX_TOKENS: '321' },
      { promptOverrides: { 'report.summarize': { model: 'gpt-4.1-mini' } } },
    );
    const scoped = ai.withContext?.({ tenantId: 'tenant-1' });

    await scoped?.generateWithUsage({ prompt: 'report.summarize', input });

    expect(openai.requests[0]).toMatchObject({ model: 'gpt-4.1-mini', maxTokens: 321 });
  });

  it('stops applying an override the resolver no longer returns', async () => {
    const { ai, openai } = wiredService(
      { PROMPT_REPORT_SUMMARIZE_MODEL: 'gpt-4o-mini' },
      {
        defaultModel: 'dynamic-default',
        promptOverrides: { 'report.summarize': { model: 'gpt-4.1-mini', maxTokens: 222 } },
      },
      {},
    );

    await ai.generateWithUsage({ prompt: 'report.summarize', input });
    await ai.generateWithUsage({ prompt: 'report.summarize', input });
    await ai.generateWithUsage({ prompt: 'plain', input });

    expect(openai.requests.map((r) => [r.model, r.maxTokens])).toEqual([
      ['gpt-4.1-mini', 222],
      ['gpt-4o-mini', 64_000],
      ['configured-default', undefined],
    ]);
  });

  it('routes calls by the dynamic defaultProvider and model, and back to the configured ones', async () => {
    const { ai, openai, anthropic } = wiredService(
      {},
      { defaultProvider: 'anthropic', defaultModel: 'claude-x' },
      {},
    );

    await ai.generateWithUsage({ prompt: 'plain', input });
    await ai.generateWithUsage({ prompt: 'plain', input });

    expect(anthropic.requests.map((r) => r.model)).toEqual(['claude-x']);
    expect(openai.requests.map((r) => r.model)).toEqual(['configured-default']);
  });

  it('falls back to the configured defaults in a withContext service too', async () => {
    const { ai, openai } = wiredService({}, { defaultModel: 'dynamic-default' }, {});

    await ai.generateWithUsage({ prompt: 'plain', input });
    const scoped = ai.withContext?.({ tenantId: 'tenant-1' });
    await scoped?.generateWithUsage({ prompt: 'plain', input });

    expect(openai.requests.map((r) => r.model)).toEqual(['dynamic-default', 'configured-default']);
  });

  it("lets a dynamic reasoningEffort replace the definition's reasoning, as one setting", async () => {
    const { ai, openai } = wiredService(
      {},
      { promptOverrides: { 'report.reason': { reasoningEffort: 'low' } } },
      { promptOverrides: { 'report.reason': { model: 'gpt-4.1-mini' } } },
    );

    await ai.generateWithUsage({ prompt: 'report.reason', input });
    await ai.generateWithUsage({ prompt: 'report.reason', input });

    // Sending both would let the definition's `reasoning` win at the adapter.
    expect(openai.requests[0]?.reasoningEffort).toBe('low');
    expect(openai.requests[0]?.reasoning).toBeUndefined();
    // An override that leaves reasoning unset keeps the definition's.
    expect(openai.requests[1]?.reasoning).toEqual({ mode: 'effort', effort: 'high' });
    expect(openai.requests[1]?.reasoningEffort).toBeUndefined();
  });
});
