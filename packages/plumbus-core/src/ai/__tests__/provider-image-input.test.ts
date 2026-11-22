import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageToBase64 } from '../image-input.js';
import { createAnthropicAdapter, createOpenAIAdapter, type ProviderRequest } from '../provider.js';
import { blankPng, jpegHeader } from './image-fixtures.js';

const png = { mediaType: 'image/png' as const, data: blankPng(4, 3) };
const jpeg = { mediaType: 'image/jpeg' as const, data: jpegHeader(10, 20) };
const pngUrl = `data:image/png;base64,${imageToBase64(png)}`;
const jpegUrl = `data:image/jpeg;base64,${imageToBase64(jpeg)}`;

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

const chatAnswer = {
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  model: 'gpt-4o',
  usage: { prompt_tokens: 900, completion_tokens: 5, total_tokens: 905 },
};

const responsesAnswer = {
  id: 'resp_1',
  status: 'completed',
  model: 'gpt-5.6-sol',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: { input_tokens: 900, output_tokens: 3, total_tokens: 903 },
};

const anthropicAnswer = {
  content: [{ type: 'text', text: 'ok' }],
  model: 'claude-sonnet-5-5',
  usage: { input_tokens: 1200, output_tokens: 3 },
  stop_reason: 'end_turn',
};

function sentBody(mockFetch: ReturnType<typeof vi.fn>): Record<string, any> {
  return JSON.parse(mockFetch.mock.calls[0]?.[1].body);
}

function sseResponse(lines: string[]) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join('\n')));
        controller.close();
      },
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI adapter image input', () => {
  it('declares image input and estimates by the tile rule', () => {
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
    expect(adapter.capabilities?.imageInput).toBe(true);
    expect(
      adapter.estimateImageInputTokens?.(
        { mediaType: 'image/png', width: 1024, height: 1024, byteLength: 1 },
        'gpt-4o',
      ),
    ).toBe(85 + 170 * 4);
  });

  it('Chat Completions: images go before the prompt as image_url data URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(chatAnswer));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });
    const response = await adapter.complete({
      system: 'Read the page',
      prompt: 'page text',
      images: [png, jpeg],
    });
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(sentBody(mockFetch).messages).toEqual([
      { role: 'system', content: 'Read the page' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: pngUrl } },
          { type: 'image_url', image_url: { url: jpegUrl } },
          { type: 'text', text: 'page text' },
        ],
      },
    ]);
    // The ledger takes the provider's own count.
    expect(response.usage.inputTokens).toBe(900);
  });

  it('Chat Completions: image parts of a user turn keep their order; strings stay strings', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(chatAnswer));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });
    await adapter.complete({
      prompt: '',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', ...png },
          ],
        },
      ],
    });
    expect(sentBody(mockFetch).messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: pngUrl } },
        ],
      },
    ]);
  });

  it('Chat Completions stream: images are sent the same way', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
          '',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":900,"completion_tokens":1,"total_tokens":901}}',
          '',
          'data: [DONE]',
          '',
        ]),
      );
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });
    for await (const _event of adapter.stream({ prompt: 'describe', images: [png] })) {
      // drain
    }
    expect(sentBody(mockFetch).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: pngUrl } },
          { type: 'text', text: 'describe' },
        ],
      },
    ]);
  });

  it('Responses API: images are input_image parts with data URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(responsesAnswer));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.6-sol' });
    const request: ProviderRequest = {
      prompt: 'page text',
      images: [png],
      tools: [
        {
          name: 'note',
          description: 'Take a note',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
      reasoning: { mode: 'effort', effort: 'high' },
    };
    await adapter.complete(request);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(sentBody(mockFetch).input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: pngUrl },
          { type: 'input_text', text: 'page text' },
        ],
      },
    ]);
  });

  it('Responses API: image parts in a multi-turn user message', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(responsesAnswer));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.6-sol' });
    await adapter.complete({
      prompt: '',
      messages: [{ role: 'user', content: [{ type: 'image', ...jpeg }] }],
      tools: [
        {
          name: 'note',
          description: 'Take a note',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
      reasoning: { mode: 'effort', effort: 'high' },
    });
    expect(sentBody(mockFetch).input).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: jpegUrl }] },
    ]);
  });
});

describe('Anthropic adapter image input', () => {
  it('declares image input and Anthropic limits', () => {
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant' });
    expect(adapter.capabilities?.imageInput).toBe(true);
    expect(adapter.capabilities?.imageInputLimits).toMatchObject({
      maxImageBytes: 5 * 1024 * 1024,
      maxImages: 100,
    });
    expect(
      adapter.estimateImageInputTokens?.(
        { mediaType: 'image/png', width: 300, height: 300, byteLength: 1 },
        'claude-sonnet-5-5',
      ),
    ).toBe(120);
  });

  it('sends image blocks with base64 sources before the prompt text', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(anthropicAnswer));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant', model: 'claude-sonnet-5-5' });
    const response = await adapter.complete({ prompt: 'page text', images: [png, jpeg] });
    expect(sentBody(mockFetch).messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageToBase64(png) },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageToBase64(jpeg) },
          },
          { type: 'text', text: 'page text' },
        ],
      },
    ]);
    expect(response.usage.inputTokens).toBe(1200);
  });

  it('maps image parts in user turns and keeps the cache mark on the last block', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(anthropicAnswer));
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant', model: 'claude-sonnet-5-5' });
    await adapter.complete({
      prompt: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', ...png },
            { type: 'text', text: 'what is this?' },
          ],
        },
      ],
      cache: { messages: true },
    });
    expect(sentBody(mockFetch).messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageToBase64(png) },
          },
          { type: 'text', text: 'what is this?', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('stream: images are sent the same way', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'event: message_start',
          'data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":1200,"output_tokens":0}}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ]),
      );
    vi.stubGlobal('fetch', mockFetch);
    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant', model: 'claude-sonnet-5-5' });
    for await (const _event of adapter.stream({ prompt: 'describe', images: [png] })) {
      // drain
    }
    expect(sentBody(mockFetch).messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageToBase64(png) },
    });
  });
});
