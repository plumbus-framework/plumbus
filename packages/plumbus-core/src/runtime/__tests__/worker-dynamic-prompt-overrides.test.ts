import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createPromptRegistry } from '../../ai/prompt-registry.js';
import { isProviderTimeoutError } from '../../ai/provider.js';
import { loadConfig } from '../../config/loader.js';
import { definePrompt } from '../../define/definePrompt.js';
import { buildWorkerAiService } from '../bootstrap.js';

const summarize = definePrompt({
  name: 'report.summarize',
  description: 'Summarize the text',
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  model: { name: 'gpt-4o', maxTokens: 64_000 },
});

const ANSWER = {
  choices: [{ message: { content: '{"summary":"s"}' }, finish_reason: 'stop' }],
  model: 'gpt-4.1-mini',
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
};

/** The worker pool's AI service, built from env and an app `resolveAiOverrides`. */
function workerService(
  env: Record<string, string>,
  resolveAiOverrides: Parameters<typeof buildWorkerAiService>[0]['resolveAiOverrides'],
) {
  const config = loadConfig({
    environment: 'development',
    env: {
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_OPENAI_BASE_URL: 'http://openai.invalid/v1',
      ...env,
    },
  });
  const ai = buildWorkerAiService({
    config,
    db: {} as never,
    promptRegistry: createPromptRegistry([summarize]),
    resolveAiOverrides,
  });
  if (!ai) throw new Error('worker AI service was not built');
  return ai;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker AI service: resolveAiOverrides merged over PROMPT_{NAME}_* field by field', () => {
  it("sends the dynamic model, keyed by the prompt's name, with the env max tokens", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(ANSWER), { status: 200 });
      }),
    );
    const ai = workerService(
      { PROMPT_REPORT_SUMMARIZE_MODEL: 'gpt-4o-mini', PROMPT_REPORT_SUMMARIZE_MAX_TOKENS: '321' },
      async () => ({ promptOverrides: { 'report.summarize': { model: 'gpt-4.1-mini' } } }),
    );

    await ai.generateWithUsage({ prompt: 'report.summarize', input: { text: 't' } });

    expect(bodies[0]).toMatchObject({ model: 'gpt-4.1-mini', max_tokens: 321 });
  });

  it('ends the request at the env PROMPT_{NAME}_TIMEOUT_MS when the dynamic override sets only the model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const ai = workerService({ PROMPT_REPORT_SUMMARIZE_TIMEOUT_MS: '50' }, async () => ({
      promptOverrides: { report_summarize: { model: 'gpt-4.1-mini' } },
    }));

    const startedAt = Date.now();
    const error = await ai
      .generateWithUsage({ prompt: 'report.summarize', input: { text: 't' } })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(isProviderTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({ timeoutMs: 50 });
  });
});
