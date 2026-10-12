import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import type { PromptDefinition } from '../../types/prompt.js';
import { type AIServiceConfig, createAIService } from '../ai-service.js';
import type { AICostRecord } from '../cost-tracker.js';
import {
  type AIProviderAdapter,
  createOpenAIAdapter,
  ProviderAPIError,
  type ProviderRequest,
  type ProviderStreamEvent,
} from '../provider.js';
import { AIInvalidRequestError } from '../refusal.js';

const summarize = definePrompt({
  name: 'summarize',
  description: 'Summarize the text',
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string(), points: z.array(z.string()) }),
  model: { maxTokens: 64_000, timeoutMs: 900_000 },
});

const untimed = definePrompt({
  name: 'untimed',
  description: 'Summarize the text',
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string(), points: z.array(z.string()) }),
});

const ANSWER = '{"summary":"s","points":["p"]}';

/** A provider that records every request and answers it. */
function recordingProvider(
  streamed: string = ANSWER,
): AIProviderAdapter & { requests: ProviderRequest[]; streams: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const streams: ProviderRequest[] = [];
  return {
    name: 'openai',
    requests,
    streams,
    async complete(request) {
      requests.push(request);
      return {
        content: ANSWER,
        model: 'gpt-4o',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      };
    },
    async *stream(request): AsyncIterable<ProviderStreamEvent> {
      streams.push(request);
      yield { type: 'content_delta', delta: streamed };
      yield { type: 'done', finishReason: 'stop' };
    },
    async embed() {
      return { embeddings: [], model: 'embed', usage: { totalTokens: 0 } };
    },
  };
}

function service(
  provider: AIProviderAdapter,
  rest: Partial<AIServiceConfig> = {},
  prompts: readonly PromptDefinition[] = [summarize, untimed],
) {
  return createAIService({
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
    prompts,
    ...rest,
  });
}

async function drain(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('per-prompt request timeout', () => {
  it("sends the prompt's model.timeoutMs as the provider request timeout", async () => {
    const provider = recordingProvider();
    await service(provider).generateWithUsage({ prompt: 'summarize', input: { text: 't' } });
    expect(provider.requests[0]?.timeout).toBe(900_000);
  });

  it("keeps the adapter's requestTimeout when neither prompt nor call sets one", async () => {
    const provider = recordingProvider();
    await service(provider).generateWithUsage({ prompt: 'untimed', input: { text: 't' } });
    expect(provider.requests[0]).not.toHaveProperty('timeout');
  });

  it('resolves per call → prompt override → prompt definition', async () => {
    const provider = recordingProvider();
    const ai = service(provider, { promptOverrides: { summarize: { timeoutMs: 30_000 } } });
    await ai.generateWithUsage({ prompt: 'summarize', input: { text: 't' } });
    await ai.generateWithUsage({ prompt: 'summarize', input: { text: 't' }, timeoutMs: 5_000 });
    await ai.generate({ prompt: 'untimed', input: { text: 't' }, timeoutMs: 7_000 });
    expect(provider.requests.map((request) => request.timeout)).toEqual([30_000, 5_000, 7_000]);
  });

  it('gives every validation retry the same timeout', async () => {
    const provider = recordingProvider();
    let calls = 0;
    provider.complete = async (request) => {
      provider.requests.push(request);
      calls += 1;
      return {
        content: calls === 1 ? '{"summary":1}' : ANSWER,
        model: 'gpt-4o',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      };
    };
    await service(provider).generateWithUsage({ prompt: 'summarize', input: { text: 't' } });
    expect(provider.requests.map((request) => request.timeout)).toEqual([900_000, 900_000]);
  });

  it('applies to streamGenerate and to its non-streaming validation fallback', async () => {
    const provider = recordingProvider('not json');
    const ai = service(provider);
    await drain(ai.streamGenerate({ prompt: 'summarize', input: { text: 't' } }));
    await drain(ai.streamGenerate({ prompt: 'untimed', input: { text: 't' }, timeoutMs: 4_000 }));
    expect(provider.streams.map((request) => request.timeout)).toEqual([900_000, 4_000]);
    // Both streams produced invalid JSON, so each was replayed without streaming.
    expect(provider.requests.map((request) => request.timeout)).toEqual([900_000, 4_000]);
  });

  it.each([
    0,
    1.5,
    Number.NaN,
    2 ** 31,
  ])('refuses a per-call timeoutMs of %s before calling the provider', async (timeoutMs) => {
    const provider = recordingProvider();
    const ai = service(provider);
    await expect(
      ai.generateWithUsage({ prompt: 'summarize', input: { text: 't' }, timeoutMs }),
    ).rejects.toBeInstanceOf(AIInvalidRequestError);
    await expect(
      drain(ai.streamGenerate({ prompt: 'summarize', input: { text: 't' }, timeoutMs })),
    ).rejects.toBeInstanceOf(AIInvalidRequestError);
    expect(provider.requests).toHaveLength(0);
    expect(provider.streams).toHaveLength(0);
  });
});

describe('per-prompt request timeout against a provider that does not answer', () => {
  // A fake OpenAI endpoint that takes every request and never answers.
  let server: Server;
  let baseUrl = '';
  const held = new Set<ServerResponse>();
  let respond: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      held.add(res);
      req.resume();
      req.on('end', () => respond(req, res));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    respond = () => undefined;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('unhandledRejection', onUnhandled);
    for (const res of held) if (!res.writableEnded) res.destroy();
    held.clear();
    expect(unhandled).toEqual([]);
  });

  function stalledService(timeoutMs: number, rows: AICostRecord[]) {
    const prompt = definePrompt({
      name: 'quick',
      description: 'Answer quickly',
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string(), points: z.array(z.string()) }),
      model: { name: 'gpt-4o', maxTokens: 1_000, timeoutMs },
    });
    // The adapter keeps its 120 s default: only the prompt asks for less.
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl });
    return service(adapter, { onAICostRecorded: (row) => void rows.push(row) }, [prompt]);
  }

  it('fails a generate call at the prompt timeout as a non-retryable provider failure', async () => {
    const rows: AICostRecord[] = [];
    const ai = stalledService(300, rows);
    const startedAt = Date.now();
    const error = await ai.generateWithUsage({ prompt: 'quick', input: { text: 't' } }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(ProviderAPIError);
    expect(error).toMatchObject({
      providerName: 'openai',
      retryable: false,
      timeoutMs: 300,
      message: 'OpenAI API request timed out after 300 ms',
    });
    // The provider had the request: the attempt may have been billed, so it is not free.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', cost: null });
    expect(rows[0]?.estimatedCost).toBeGreaterThan(0);
    expect(rows[0]?.errorMessage).toBe('OpenAI API request timed out after 300 ms');
  });

  it('fails a stream cut off mid-answer at the prompt timeout', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"{\\"summary\\""}}]}\n\n');
    };
    const rows: AICostRecord[] = [];
    const ai = stalledService(400, rows);
    const seen: unknown[] = [];
    const error = await (async () => {
      for await (const event of ai.streamGenerate({ prompt: 'quick', input: { text: 't' } })) {
        seen.push(event);
      }
    })().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(seen).toEqual([{ type: 'delta', text: '{"summary"' }]);
    expect(error).toBeInstanceOf(ProviderAPIError);
    expect(error).toMatchObject({ retryable: false, timeoutMs: 400 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', cost: null });
  });
});
