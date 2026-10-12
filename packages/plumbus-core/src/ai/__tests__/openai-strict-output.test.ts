// OpenAI strict-mode request shapes, end to end through the OpenAI adapter (and the AI service):
// the object-root envelope, allOf merging, Responses reasoning tokens, and caller tools that stay
// non-strict on the Responses API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { createCostTracker } from '../cost-tracker.js';
import { estimateModelCost } from '../model-pricing.js';
import { type AITool, createOpenAIAdapter, type ProviderRequest } from '../provider.js';
import { generateWithValidation } from '../validation.js';
import { zodToProviderJsonSchema } from '../zod-to-provider-schema.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Chat Completions answer whose message carries `content` (or a structured tool call). */
function chatAnswer(args: {
  content?: string | null;
  toolArguments?: string;
  usage?: Record<string, unknown>;
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'gpt-4o',
      choices: [
        {
          message: {
            content: args.content ?? null,
            ...(args.toolArguments
              ? {
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'return_structured_response',
                        arguments: args.toolArguments,
                      },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: args.toolArguments ? 'tool_calls' : 'stop',
        },
      ],
      usage: args.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

/** A Responses answer with the given output items. */
function responsesAnswer(args: {
  output: Record<string, unknown>[];
  usage?: Record<string, unknown>;
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      model: 'gpt-6-luna',
      output: args.output,
      usage: args.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
  };
}

function messageItem(text: string) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function sentBody(mockFetch: ReturnType<typeof vi.fn>, call = 0): Record<string, any> {
  return JSON.parse(String(mockFetch.mock.calls[call]?.[1].body));
}

/** An SSE body that streams `deltas` as Chat Completions content, then usage. */
function chatStream(deltas: string[], usage: Record<string, unknown>) {
  const lines = [
    ...deltas.map(
      (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const labelsSchema = zodToProviderJsonSchema(z.array(z.string())).schema;
const enveloped = {
  type: 'object',
  properties: { value: { type: 'array', items: { type: 'string' } } },
  required: ['value'],
  additionalProperties: false,
};

function hasAllOf(schema: unknown): boolean {
  return JSON.stringify(schema).includes('"allOf"');
}

describe('OpenAI strict outputs whose root is not an object', () => {
  const paths: {
    path: string;
    model: string;
    request: Partial<ProviderRequest>;
    url: string;
    sentSchema: (body: Record<string, any>) => unknown;
    answer: (json: string) => unknown;
  }[] = [
    {
      path: 'Chat Completions response_format',
      model: 'gpt-4o',
      request: {},
      url: 'https://api.openai.com/v1/chat/completions',
      sentSchema: (body) => body.response_format.json_schema.schema,
      answer: (json) => chatAnswer({ content: json }),
    },
    {
      path: "Chat Completions structuredOutputTransport: 'tool'",
      model: 'gpt-4o',
      request: { structuredOutputTransport: 'tool' },
      url: 'https://api.openai.com/v1/chat/completions',
      sentSchema: (body) => body.tools[0].function.parameters,
      answer: (json) => chatAnswer({ toolArguments: json }),
    },
    {
      path: "Responses structuredOutputTransport: 'tool' (GPT-6 reasoning)",
      model: 'gpt-6-luna',
      request: { structuredOutputTransport: 'tool' },
      url: 'https://api.openai.com/v1/responses',
      sentSchema: (body) => body.tools[0].parameters,
      answer: (json) =>
        responsesAnswer({
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'return_structured_response',
              arguments: json,
            },
          ],
        }),
    },
    {
      path: 'Responses text.format (next to caller tools)',
      model: 'gpt-6-luna',
      request: {
        tools: [
          {
            name: 'lookup',
            description: 'Look up',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      url: 'https://api.openai.com/v1/responses',
      sentSchema: (body) => body.text.format.schema,
      answer: (json) => responsesAnswer({ output: [messageItem(json)] }),
    },
  ];

  it.each(paths)('sends an object envelope and returns the bare answer on $path', async ({
    model,
    request,
    url,
    sentSchema,
    answer,
  }) => {
    const mockFetch = vi.fn().mockResolvedValue(answer('{"value":["billing","urgent"]}'));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model });

    const response = await adapter.complete({
      prompt: 'Classify',
      responseFormat: 'json',
      responseSchema: labelsSchema,
      ...request,
    });

    expect(mockFetch.mock.calls[0]?.[0]).toBe(url);
    expect(sentSchema(sentBody(mockFetch))).toEqual(enveloped);
    expect(response.content).toBe('["billing","urgent"]');
  });

  it('leaves an object root as it is: no envelope sent, the answer returned unchanged', async () => {
    const mockFetch = vi.fn().mockResolvedValue(chatAnswer({ content: '{"value":["a"]}' }));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });
    const responseSchema = zodToProviderJsonSchema(z.object({ value: z.array(z.string()) })).schema;

    const response = await adapter.complete({
      prompt: 'x',
      responseFormat: 'json',
      responseSchema,
    });

    expect(sentBody(mockFetch).response_format.json_schema.schema).toEqual({
      type: 'object',
      properties: { value: { type: 'array', items: { type: 'string' } } },
      required: ['value'],
      additionalProperties: false,
    });
    expect(response.content).toBe('{"value":["a"]}');
  });

  it('takes the envelope out of a streamed answer, delta by delta', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      chatStream(['{"va', 'lue":[', '"billing"', ',"urgent"]', '}'], {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });

    const deltas: string[] = [];
    for await (const event of adapter.stream({
      prompt: 'Classify',
      responseFormat: 'json',
      responseSchema: labelsSchema,
    })) {
      if (event.type === 'content_delta' && event.delta) deltas.push(event.delta);
    }

    expect(sentBody(mockFetch).response_format.json_schema.schema).toEqual(enveloped);
    expect(deltas).toEqual(['[', '"billing"', ',"urgent"]']);
  });

  it('classify() sends the envelope and returns the labels', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(chatAnswer({ content: '{"value":["billing","not-a-label"]}' }));
    vi.stubGlobal('fetch', mockFetch);
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' }), {
        enableStrictStructuredOutputs: true,
      }),
    );

    const labels = await ai.classify({ labels: ['billing', 'technical'], text: 'Refund please' });

    expect(labels).toEqual(['billing']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBody(mockFetch).response_format.json_schema.schema).toEqual(enveloped);
  });

  it('extract() with an array schema, and optional properties inside it, validates the answer', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      chatAnswer({
        content: '{"value":[{"name":"Ada","email":null},{"name":"Bob","email":"b@example.com"}]}',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' }), {
        enableStrictStructuredOutputs: true,
      }),
    );

    const people = await ai.extract({
      schema: z.array(z.object({ name: z.string(), email: z.string().email().optional() })),
      text: 'Ada, and Bob <b@example.com>',
    });

    expect(people).toEqual([{ name: 'Ada' }, { name: 'Bob', email: 'b@example.com' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = sentBody(mockFetch).response_format.json_schema.schema;
    expect(sent.type).toBe('object');
    expect(sent.required).toEqual(['value']);
  });

  it('generate() and streamGenerate() with a union output return the bare answer', async () => {
    const output = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('answer'), text: z.string(), source: z.string().optional() }),
      z.object({ kind: z.literal('refer'), team: z.string() }),
    ]);
    const prompt = definePrompt({
      name: 'route',
      description: 'Route {{ticket}}',
      input: z.object({ ticket: z.string() }),
      output,
    });
    const json = '{"value":{"kind":"answer","text":"Reset it","source":null}}';
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(chatAnswer({ content: json }))
      .mockResolvedValueOnce(
        chatStream([json.slice(0, 12), json.slice(12)], {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18,
        }),
      );
    vi.stubGlobal('fetch', mockFetch);
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' }), {
        enableStrictStructuredOutputs: true,
        prompts: [prompt],
      }),
    );

    expect(await ai.generate({ prompt: 'route', input: { ticket: 'login' } })).toEqual({
      kind: 'answer',
      text: 'Reset it',
    });
    const events = [];
    for await (const event of ai.streamGenerate({ prompt: 'route', input: { ticket: 'login' } })) {
      events.push(event);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const sent = sentBody(mockFetch, 1).response_format.json_schema.schema;
    expect(Object.keys(sent.properties)).toEqual(['value']);
    expect(sent.properties.value.anyOf).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => (event as { text: string }).text)
        .join(''),
    ).toBe('{"kind":"answer","text":"Reset it","source":null}');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      data: { kind: 'answer', text: 'Reset it' },
    });
    // The streamed text validated: no non-streaming fallback call.
    expect((events.at(-1) as { validationFallbackFired?: boolean }).validationFallbackFired).toBe(
      false,
    );
  });
});

describe('OpenAI strict outputs with allOf', () => {
  const output = z.object({
    network: z.string().cidr(),
    owner: z.object({ id: z.string() }).and(z.object({ email: z.string().email().optional() })),
  });

  it.each([
    ['Chat Completions response_format', 'gpt-4o', {}],
    ["Chat Completions structuredOutputTransport: 'tool'", 'gpt-4o', { tool: true }],
    ["Responses structuredOutputTransport: 'tool'", 'gpt-6-luna', { tool: true }],
  ] as const)('sends no allOf on %s, and Zod still checks the original', async (_path, model, options) => {
    const json = '{"network":"10.0.0.0/8","owner":{"id":"u1","email":null}}';
    const mockFetch = vi.fn().mockResolvedValue(
      model === 'gpt-6-luna'
        ? responsesAnswer({
            output: [
              {
                type: 'function_call',
                call_id: 'c1',
                name: 'return_structured_response',
                arguments: json,
              },
            ],
          })
        : 'tool' in options
          ? chatAnswer({ toolArguments: json })
          : chatAnswer({ content: json }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model }), {
        enableStrictStructuredOutputs: true,
        prompts: [
          definePrompt({
            name: 'network',
            description: 'Describe {{x}}',
            input: z.object({ x: z.string() }),
            output,
            ...('tool' in options ? { structuredOutputTransport: 'tool' as const } : {}),
          }),
        ],
      }),
    );

    const data = await ai.generate({ prompt: 'network', input: { x: 'lab' } });

    expect(data).toEqual({ network: '10.0.0.0/8', owner: { id: 'u1' } });
    const body = sentBody(mockFetch);
    expect(hasAllOf(body)).toBe(false);
    // The IPv4 and IPv6 patterns of cidr() go as alternatives, not both required.
    const patterns = [...JSON.stringify(body).matchAll(/"pattern":"((?:[^"\\]|\\.)*)"/g)].map(
      (match) => new RegExp(JSON.parse(`"${match[1]}"`)),
    );
    expect(patterns).toHaveLength(2);
    expect(patterns.map((pattern) => pattern.test('10.0.0.0/8'))).toEqual([true, false]);
    expect(patterns.map((pattern) => pattern.test('2001:db8::/32'))).toEqual([false, true]);
  });

  it('validates on the first answer an output that intersects an object with a discriminated union', async () => {
    const intersected = z
      .object({ title: z.string(), note: z.string().optional() })
      .and(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), body: z.string(), hint: z.string().optional() }),
          z.object({ kind: z.literal('count'), n: z.number() }),
        ]),
      );
    const mockFetch = vi.fn().mockResolvedValue(
      chatAnswer({
        content: '{"value":{"title":"T","note":null,"kind":"text","body":"B","hint":null}}',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' }), {
        enableStrictStructuredOutputs: true,
        prompts: [
          definePrompt({
            name: 'card',
            description: 'Card for {{x}}',
            input: z.object({ x: z.string() }),
            output: intersected,
          }),
        ],
      }),
    );

    const data = await ai.generate({ prompt: 'card', input: { x: 'lab' } });

    expect(data).toEqual({ title: 'T', kind: 'text', body: 'B' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = sentBody(mockFetch).response_format.json_schema.schema;
    expect(hasAllOf(sent)).toBe(false);
    // Each branch carries the object's properties; nothing sits next to the anyOf.
    expect(Object.keys(sent.properties.value)).toEqual(['anyOf']);
    expect(
      sent.properties.value.anyOf.map((branch: { required: string[] }) => branch.required),
    ).toEqual([
      ['title', 'note', 'kind', 'body', 'hint'],
      ['title', 'note', 'kind', 'n'],
    ]);
  });
});

describe('an enveloped answer cut off at max_tokens', () => {
  it('Chat Completions: AIIncompleteOutputError.partialText holds the answer, not the envelope', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-4o',
        choices: [{ message: { content: '{"value":["billing","urg' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });

    const error = await adapter
      .complete({ prompt: 'Classify', responseFormat: 'json', responseSchema: labelsSchema })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'AIIncompleteOutputError',
      partialText: '["billing","urg',
    });
  });

  it('Responses structured tool: the content is the cut-off answer, not the envelope', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'gpt-6-luna',
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'return_structured_response',
            arguments: '{"value":["billing","urg',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' });

    const response = await adapter.complete({
      prompt: 'Classify',
      responseFormat: 'json',
      responseSchema: labelsSchema,
      structuredOutputTransport: 'tool',
    });

    expect(response).toMatchObject({ finishReason: 'length', content: '["billing","urg' });
  });
});

describe('reasoning tokens on the Responses API', () => {
  const responsesUsage = {
    input_tokens: 120,
    output_tokens: 300,
    total_tokens: 420,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 256 },
  };

  it('reports output_tokens_details.reasoning_tokens like Chat Completions does', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        responsesAnswer({ output: [messageItem('done')], usage: responsesUsage }),
      )
      .mockResolvedValueOnce(
        chatAnswer({
          content: 'done',
          usage: {
            prompt_tokens: 120,
            completion_tokens: 300,
            total_tokens: 420,
            completion_tokens_details: { reasoning_tokens: 256 },
          },
        }),
      );
    vi.stubGlobal('fetch', mockFetch);
    const tools: AITool[] = [
      {
        name: 'lookup',
        description: 'Look up',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ];

    const responses = await createOpenAIAdapter({
      apiKey: 'sk-test',
      model: 'gpt-6-luna',
    }).complete({ prompt: 'x', tools });
    const chat = await createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' }).complete({
      prompt: 'x',
      tools,
    });

    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(responses.usage).toEqual({
      inputTokens: 120,
      outputTokens: 300,
      totalTokens: 420,
      cachedInputTokens: 0,
      reasoningTokens: 256,
    });
    expect(chat.usage).toEqual(responses.usage);
  });

  it('reports them on a Chat Completions stream too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatStream(['hi'], {
          prompt_tokens: 12,
          completion_tokens: 40,
          total_tokens: 52,
          completion_tokens_details: { reasoning_tokens: 32 },
        }),
      ),
    );
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.4' });

    const usage = [];
    for await (const event of adapter.stream({ prompt: 'x' })) {
      if (event.type === 'usage') usage.push(event.usage);
    }

    expect(usage).toEqual([
      {
        inputTokens: 12,
        outputTokens: 40,
        totalTokens: 52,
        cachedInputTokens: 0,
        reasoningTokens: 32,
      },
    ]);
  });

  it('generateWithUsage on the structured tool (GPT-6) returns them, prices output_tokens once, and the ledger keeps them', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      responsesAnswer({
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'return_structured_response',
            arguments: '{"ok":true}',
          },
        ],
        usage: responsesUsage,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const costTracker = createCostTracker();
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' }), {
        enableStrictStructuredOutputs: true,
        costTracker,
        defaultModel: 'gpt-6-luna',
        prompts: [
          definePrompt({
            name: 'check',
            description: 'Check {{x}}',
            input: z.object({ x: z.string() }),
            output: z.object({ ok: z.boolean() }),
            structuredOutputTransport: 'tool',
          }),
        ],
      }),
    );

    const result = await ai.generateWithUsage({ prompt: 'check', input: { x: 'y' } });

    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(result.data).toEqual({ ok: true });
    expect(result.usage).toMatchObject({ outputTokens: 300, reasoningTokens: 256 });
    // output_tokens already includes the reasoning tokens; they are not charged a second time.
    expect(result.cost).toBe(estimateModelCost(120, 300, 'gpt-6-luna', { cachedInputTokens: 0 }));
    expect(costTracker.getRecords()[0]?.usage).toMatchObject({
      outputTokens: 300,
      reasoningTokens: 256,
    });
    expect(costTracker.getRecords()[0]?.cost).toBe(result.cost);
  });

  it('sums them over validation retries', async () => {
    const answers = ['{"ok":"no"}', '{"ok":true}'];
    const provider = {
      name: 'openai',
      complete: vi.fn(async () => ({
        content: answers.shift() ?? '',
        model: 'gpt-6-luna',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60, reasoningTokens: 40 },
      })),
      stream: vi.fn(),
      embed: vi.fn(),
    };

    const result = await generateWithValidation(
      provider as never,
      { prompt: 'x', responseFormat: 'json' },
      z.object({ ok: z.boolean() }),
    );

    expect(result.attempts).toBe(2);
    expect(result.usage).toMatchObject({ outputTokens: 100, reasoningTokens: 80 });
  });

  it('leaves reasoningTokens out when no attempt reported them', async () => {
    const provider = {
      name: 'openai',
      complete: vi.fn(async () => ({
        content: '{"ok":true}',
        model: 'gpt-4o',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })),
      stream: vi.fn(),
      embed: vi.fn(),
    };

    const result = await generateWithValidation(
      provider as never,
      { prompt: 'x', responseFormat: 'json' },
      z.object({ ok: z.boolean() }),
    );

    expect(result.usage).not.toHaveProperty('reasoningTokens');
  });
});

describe('caller tools on the Responses API', () => {
  it('are sent with strict: false, so OpenAI does not make their optional arguments required', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      responsesAnswer({
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const parameters = zodToProviderJsonSchema(
      z.object({ city: z.string(), unit: z.enum(['celsius', 'fahrenheit']).optional() }),
    ).schema;

    const response = await createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' }).complete(
      {
        prompt: 'Weather in Paris',
        tools: [{ name: 'get_weather', description: 'Weather for a city', parameters }],
      },
    );

    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(sentBody(mockFetch).tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Weather for a city',
        parameters,
        strict: false,
      },
    ]);
    expect(response.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'get_weather',
        argumentsStatus: 'parsed',
        arguments: { city: 'Paris' },
      },
    ]);
  });
});
