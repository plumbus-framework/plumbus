import { describe, expect, it, vi } from 'vitest';
import { createAnthropicAdapter, createOpenAIAdapter, normalizeFinishReason } from '../provider.js';
import { AIInvalidRequestError } from '../refusal.js';

const sampleTool = {
  name: 'do_thing',
  description: 'Do a thing',
  parameters: {
    type: 'object',
    properties: { x: { type: 'number' } },
    required: ['x'],
  },
};

function mockOpenAIResponse(overrides: {
  finish_reason?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  content?: string | null;
}) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: overrides.content ?? '',
            tool_calls: overrides.tool_calls,
          },
          finish_reason: overrides.finish_reason ?? 'stop',
        },
      ],
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

function mockOpenAIResponsesResponse(overrides: {
  status?: string;
  output?: Record<string, unknown>[];
}) {
  return {
    ok: true,
    json: async () => ({
      id: 'resp_1',
      status: overrides.status ?? 'completed',
      model: 'gpt-5.6-sol',
      output: overrides.output ?? [],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
        input_tokens_details: { cached_tokens: 3 },
      },
    }),
  };
}

function mockAnthropicResponse(overrides: {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}) {
  return {
    ok: true,
    json: async () => ({
      content: overrides.content ?? [{ type: 'text', text: '' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: overrides.stop_reason ?? 'end_turn',
    }),
  };
}

describe('provider tool calling', () => {
  describe('createOpenAIAdapter', () => {
    it('forwards caller tools as function tools with named tool_choice', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockOpenAIResponse({ finish_reason: 'stop' }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
        toolChoice: { type: 'function', function: { name: 'do_thing' } },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools[0].function.name).toBe('do_thing');
      expect(body.tool_choice.function.name).toBe('do_thing');

      vi.unstubAllGlobals();
    });

    it('sets parallel_tool_calls false when toolExecution disables it', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockOpenAIResponse({ finish_reason: 'stop' }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
        toolExecution: { parallelToolCalls: false },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parallel_tool_calls).toBe(false);

      vi.unstubAllGlobals();
    });

    it('maps disabled provider-neutral reasoning on tool requests', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockOpenAIResponse({ finish_reason: 'stop' }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'configured-model' });
      await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
        reasoning: { mode: 'disabled' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
      expect(body.reasoning_effort).toBe('none');

      vi.unstubAllGlobals();
    });

    it('uses Responses API for active reasoning with tools', async () => {
      const reasoningItem = {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning',
        summary: [],
      };
      const functionCall = {
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'do_thing',
        arguments: '{"x":1}',
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValue(mockOpenAIResponsesResponse({ output: [reasoningItem, functionCall] }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.6-sol' });
      const result = await adapter.complete({
        prompt: 'Run tool',
        system: 'Use tools when needed',
        tools: [sampleTool],
        toolChoice: { type: 'function', function: { name: 'do_thing' } },
        toolExecution: { parallelToolCalls: false },
        reasoning: { mode: 'effort', effort: 'high' },
        maxTokens: 1234,
      });

      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1].body);
      expect(body).toMatchObject({
        model: 'gpt-5.6-sol',
        instructions: 'Use tools when needed',
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'high' },
        max_output_tokens: 1234,
        parallel_tool_calls: false,
        tool_choice: { type: 'function', name: 'do_thing' },
      });
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.messages).toBeUndefined();
      expect(body.tools[0]).toMatchObject({ type: 'function', name: 'do_thing' });
      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls?.[0]).toMatchObject({
        id: 'call_1',
        name: 'do_thing',
        argumentsStatus: 'parsed',
      });
      expect(result.providerState).toEqual({
        provider: 'openai-responses',
        content: [reasoningItem, functionCall],
      });
      expect(result.usage.cachedInputTokens).toBe(3);

      vi.unstubAllGlobals();
    });

    it('uses Responses API for GPT-5.6 default reasoning with tools', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockOpenAIResponsesResponse({ output: [] }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.6-terra' });
      await adapter.complete({ prompt: 'Run tool', tools: [sampleTool] });

      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1].body);
      expect(body.reasoning).toBeUndefined();
      expect(body.tools[0].name).toBe('do_thing');

      vi.unstubAllGlobals();
    });

    it('replays encrypted Responses reasoning state with function outputs', async () => {
      const reasoningItem = {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning',
        summary: [],
      };
      const functionCall = {
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'do_thing',
        arguments: '{"x":1}',
      };
      const mockFetch = vi.fn().mockResolvedValue(
        mockOpenAIResponsesResponse({
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Done' }],
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.6-sol' });
      const result = await adapter.complete({
        prompt: '',
        reasoningEffort: 'medium',
        messages: [
          { role: 'user', content: 'Run tool' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'do_thing',
                argumentsStatus: 'parsed',
                arguments: { x: 1 },
              },
            ],
            providerState: {
              provider: 'openai-responses',
              content: [reasoningItem, functionCall],
            },
          },
          { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1', name: 'do_thing' },
        ],
      });

      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1].body);
      expect(body.reasoning).toEqual({ effort: 'medium' });
      expect(body.input).toEqual([
        { role: 'user', content: 'Run tool' },
        reasoningItem,
        functionCall,
        { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      ]);
      expect(result.content).toBe('Done');
      expect(result.finishReason).toBe('stop');

      vi.unstubAllGlobals();
    });

    it('surfaces a failed Responses result as a structured provider error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'failed',
          model: 'gpt-5.6-sol',
          output: [],
          error: { code: 'server_error', message: 'Reasoning failed' },
          usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.6-sol' });
        await expect(
          adapter.complete({
            prompt: 'Run tool',
            tools: [sampleTool],
            reasoning: { mode: 'effort', effort: 'high' },
          }),
        ).rejects.toMatchObject({
          name: 'ProviderAPIError',
          providerName: 'openai',
          retryable: false,
          attempts: 1,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('parses tool_calls into a parsed AIToolCall with finishReason tool_calls', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockOpenAIResponse({
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'do_thing', arguments: '{"x":1}' },
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const result = await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
      });

      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls?.[0]?.argumentsStatus).toBe('parsed');
      if (result.toolCalls?.[0]?.argumentsStatus === 'parsed') {
        expect((result.toolCalls[0].arguments as { x: number }).x).toBe(1);
      }

      vi.unstubAllGlobals();
    });

    it('surfaces unparseable arguments as argumentsStatus invalid', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockOpenAIResponse({
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call_bad',
              type: 'function',
              function: { name: 'do_thing', arguments: '{not json' },
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      const result = await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
      });

      expect(result.toolCalls?.[0]?.argumentsStatus).toBe('invalid');
      if (result.toolCalls?.[0]?.argumentsStatus === 'invalid') {
        expect(result.toolCalls[0].rawArguments).toBeTruthy();
      }

      vi.unstubAllGlobals();
    });

    it('serializes assistant toolCalls and tool ChatMessages onto the wire', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockOpenAIResponse({ finish_reason: 'stop' }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
      await adapter.complete({
        prompt: '',
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'do_thing',
                argumentsStatus: 'parsed',
                arguments: { x: 1 },
              },
            ],
          },
          { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1', name: 'do_thing' },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const assistantMsg = body.messages.find(
        (m: { role: string }) => m.role === 'assistant' && m.tool_calls,
      );
      const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
      expect(assistantMsg.tool_calls[0].function.name).toBe('do_thing');
      expect(toolMsg.tool_call_id).toBe('call_1');
      expect(toolMsg.content).toBe('{"ok":true}');

      vi.unstubAllGlobals();
    });
  });

  describe('createAnthropicAdapter', () => {
    it('forwards caller tools with input_schema and tool_choice', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(mockAnthropicResponse({ stop_reason: 'end_turn' }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test' });
      await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
        toolChoice: { type: 'function', function: { name: 'do_thing' } },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools[0].input_schema).toBeDefined();
      expect(body.tool_choice.type).toBe('tool');
      expect(body.tool_choice.name).toBe('do_thing');

      vi.unstubAllGlobals();
    });

    it('parses tool_use blocks into parsed AIToolCall with finishReason tool_use', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockAnthropicResponse({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'do_thing', input: { x: 42 } }],
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test' });
      const result = await adapter.complete({
        prompt: 'Run tool',
        tools: [sampleTool],
      });

      expect(result.finishReason).toBe('tool_use');
      expect(result.toolCalls?.[0]?.argumentsStatus).toBe('parsed');
      if (result.toolCalls?.[0]?.argumentsStatus === 'parsed') {
        expect(result.toolCalls[0].arguments).toEqual({ x: 42 });
      }

      vi.unstubAllGlobals();
    });

    it('builds a tool_result user message from a tool ChatMessage', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(mockAnthropicResponse({ stop_reason: 'end_turn' }));
      vi.stubGlobal('fetch', mockFetch);

      const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test' });
      await adapter.complete({
        prompt: '',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'tool', content: 'done', toolCallId: 'tu_1', name: 'do_thing' },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const lastMessage = body.messages[body.messages.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'done',
      });

      vi.unstubAllGlobals();
    });
  });

  it('both adapters throw AIInvalidRequestError when tools combine with structuredOutputTransport tool', async () => {
    const openai = createOpenAIAdapter({ apiKey: 'sk-test' });
    const anthropic = createAnthropicAdapter({ apiKey: 'sk-ant-test' });

    const request = {
      prompt: 'x',
      tools: [sampleTool],
      structuredOutputTransport: 'tool' as const,
      responseFormat: 'json' as const,
      responseSchema: { type: 'object', properties: {} },
    };

    await expect(openai.complete(request)).rejects.toMatchObject({
      name: 'AIInvalidRequestError',
      reason: 'caller_tools_conflict_with_structured_output_tool',
    });
    await expect(anthropic.complete(request)).rejects.toMatchObject({
      name: 'AIInvalidRequestError',
      reason: 'caller_tools_conflict_with_structured_output_tool',
    });
  });

  it('caller tools with an out-of-grammar name throw AIInvalidRequestError tool_name_invalid', async () => {
    const openai = createOpenAIAdapter({ apiKey: 'sk-test' });
    await expect(
      openai.complete({
        prompt: 'x',
        tools: [{ ...sampleTool, name: '123bad' }],
      }),
    ).rejects.toMatchObject({
      name: 'AIInvalidRequestError',
      reason: 'tool_name_invalid',
    });
  });

  it('both built-in adapters declare capabilities.tools true', () => {
    expect(createOpenAIAdapter({ apiKey: 'sk-test' }).capabilities?.tools).toBe(true);
    expect(createAnthropicAdapter({ apiKey: 'sk-ant-test' }).capabilities?.tools).toBe(true);
  });

  it('normalizeFinishReason maps provider reasons', () => {
    expect(normalizeFinishReason('end_turn')).toBe('stop');
    expect(normalizeFinishReason('max_tokens')).toBe('length');
    expect(normalizeFinishReason('tool_use')).toBe('tool_calls');
    expect(normalizeFinishReason('content_filter')).toBe('refusal');
    expect(normalizeFinishReason('weird')).toBe('other');
  });

  it('AIInvalidRequestError carries reason and name', () => {
    const err = new AIInvalidRequestError({ reason: 'x' });
    expect(err.name).toBe('AIInvalidRequestError');
    expect(err.reason).toBe('x');
  });
});
