import { describe, expect, it, vi } from 'vitest';
import { z } from '@plumbus/core/zod';
import type {
  AIToolCallsGenerateResult,
  AIService,
  CapabilityContract,
  ExecutionContext,
} from '@plumbus/core';
import { definePrompt } from '@plumbus/core';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import { chatScopeCheckPrompt } from '../../prompt/chat-scope-check.prompt.js';
import { chatToolRoundPrompt } from '../../prompt/chat-tool-round.prompt.js';
import { createSession } from '../../session/service.js';
import { runChatTurn } from '../run-turn.js';
import type { ChatEvent } from '../../types/event.js';

function ctxWithCaps(
  caps: CapabilityContract[],
  options: Parameters<typeof createTestContext>[0] = {},
): ExecutionContext {
  const byName = new Map(caps.map((c) => [c.name, c]));
  const ctx = createTestContext({ ...options, capabilities: caps });
  return {
    ...ctx,
    __runtime: {
      ...ctx.__runtime,
      resolveCapability: (name: string) =>
        byName.get(name) ?? ctx.__runtime?.resolveCapability?.(name),
    },
  };
}

const inScopeAnswer = {
  inScope: true,
  answer: 'Here is the answer.',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
};

function makeReadCap(name: string): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain: 'test',
    input: z.object({}),
    output: z.object({ value: z.string() }),
    effects: { data: [], events: [], external: [], ai: true },
    access: { roles: ['user'] },
    handler: async () => ({ value: 'tool-result' }),
  } as CapabilityContract;
}

function allPromptsRegistry() {
  return {
    hasPrompt: (name: string) =>
      name === chatScopeCheckPrompt.name || name === chatToolRoundPrompt.name,
  };
}

async function collectTurnEvents(
  ctx: ReturnType<typeof createTestContext>,
  chat: ReturnType<typeof defineChat>,
  args: {
    sessionId: string;
    userMessage: string;
    registry?: { hasPrompt: (name: string) => boolean };
  },
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const evt of runChatTurn(ctx, {
    chatDefinition: chat,
    sessionId: args.sessionId,
    userMessage: args.userMessage,
    audience: 'user',
    locale: 'en',
    registry: args.registry,
  })) {
    events.push(evt);
  }
  return events;
}

function toolCallingChat(capabilities: string[] = ['readThing']) {
  return defineChat({
    name: 'toolchat',
    access: {},
    instructions: ['helpful'],
    policy: {
      toolCalling: {
        enabled: true,
        capabilities,
      },
    },
  });
}

const interviewAgentPrompt = definePrompt({
  name: 'interview.agent',
  domain: 'interview',
  description: 'Answer the user directly. Use the process tool only when it is needed.',
  input: z
    .object({
      systemPrompt: z.string().optional(),
      userMessage: z.string().optional(),
      history: z.array(z.unknown()).optional(),
      periodDepthContext: z.string().optional(),
    })
    .passthrough(),
  output: z.object({ content: z.string() }),
});

function agentToolCallingChat(capabilities: string[] = ['readThing']) {
  return defineChat({
    name: 'interview',
    access: {},
    prompt: interviewAgentPrompt,
    persistence: { messageContent: 'client', saveToDb: true },
    policy: {
      toolCalling: {
        enabled: true,
        capabilities,
        orchestration: 'agent',
      },
    },
  });
}

describe('runChatTurn — Path B tool calling', () => {
  it('agent orchestration answers an ordinary turn in one model call', async () => {
    const readCap = makeReadCap('readThing');
    const generateWithUsage = vi.fn(async (config: Record<string, unknown>) => {
      expect(config.prompt).toBe('interview.agent');
      expect(config).not.toHaveProperty('model');
      expect(config).not.toHaveProperty('reasoningEffort');
      expect(config.input).toEqual(
        expect.objectContaining({ periodDepthContext: 'stay in childhood' }),
      );
      expect(config.messages).toEqual([
        { role: 'assistant', content: 'Tell me about your childhood.' },
        { role: 'user', content: 'I grew up by the sea.' },
      ]);
      return {
        finishReason: 'stop' as const,
        data: { content: 'What do you remember about the harbor?' },
        usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
        model: 'mock-agent',
        provider: 'mock',
        cost: 0.01,
      };
    });
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      features: { perCallProviderModelReasoning: true },
      generateWithUsage: generateWithUsage as AIService['generateWithUsage'],
      streamGenerate() {
        throw new Error('agent orchestration must not run a separate answer stream');
      },
    };
    const ctx = ctxWithCaps([readCap], { ai, auth: { roles: ['user'] } });
    const chat = agentToolCallingChat();
    const session = await createSession(ctx, {
      chatName: chat.name,
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events: ChatEvent[] = [];
    for await (const event of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'I grew up by the sea.',
      audience: 'user',
      locale: 'en',
      trustedHistory: [{ role: 'assistant', content: 'Tell me about your childhood.' }],
      promptInput: { periodDepthContext: 'stay in childhood' },
    })) {
      events.push(event);
    }

    expect(generateWithUsage).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'message.delta',
      text: 'What do you remember about the harbor?',
    });
    expect(events.at(-1)?.type).toBe('turn.completed');
  });

  it('agent orchestration invokes an auto tool only when the model requests it', async () => {
    const readCap = makeReadCap('readThing');
    let call = 0;
    const generateWithUsage = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          finishReason: 'tool_calls' as const,
          toolCalls: [
            {
              id: 'tc-process',
              name: 'readThing',
              argumentsStatus: 'parsed' as const,
              arguments: {},
            },
          ],
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          model: 'mock-agent',
          provider: 'mock',
          cost: 0.01,
        };
      }
      return {
        finishReason: 'stop' as const,
        data: { content: 'The tool says how the interview works.' },
        usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
        model: 'mock-agent',
        provider: 'mock',
        cost: 0.01,
      };
    });
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: generateWithUsage as AIService['generateWithUsage'],
    };
    const ctx = ctxWithCaps([readCap], { ai, auth: { roles: ['user'] } });
    const chat = agentToolCallingChat();
    const session = await createSession(ctx, {
      chatName: chat.name,
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'How does this work?',
    });

    expect(generateWithUsage).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toContain('tool.completed');
    expect(events).toContainEqual({
      type: 'message.delta',
      text: 'The tool says how the interview works.',
    });
  });

  it('forwards toolCalling.ai provider, model, and reasoning overrides to the agent call', async () => {
    const readCap = makeReadCap('readThing');
    const generateWithUsage = vi.fn(async (config: Record<string, unknown>) => {
      expect(config).toEqual(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'tool-model',
          reasoning: { mode: 'effort', effort: 'medium' },
        }),
      );
      return {
        finishReason: 'stop' as const,
        data: { content: 'Configured agent answer.' },
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        model: 'tool-model',
        provider: 'mock',
        cost: 0.01,
      };
    });
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: generateWithUsage as AIService['generateWithUsage'],
    };
    const ctx = ctxWithCaps([readCap], { ai, auth: { roles: ['user'] } });
    const chat = defineChat({
      ...agentToolCallingChat(),
      policy: {
        toolCalling: {
          enabled: true,
          capabilities: ['readThing'],
          orchestration: 'agent',
          scopePreflight: false,
          ai: {
            provider: 'anthropic',
            model: 'tool-model',
            reasoning: { mode: 'effort', effort: 'medium' },
          },
        },
      },
    });
    const session = await createSession(ctx, {
      chatName: chat.name,
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });

    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'A normal turn.',
    });

    expect(events).toContainEqual({ type: 'message.delta', text: 'Configured agent answer.' });
  });

  it('binds an explicit programmatic capability resolver when ctx.__runtime is hidden', async () => {
    const readCap = makeReadCap('readThing');
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: vi.fn(async () => ({
        finishReason: 'stop' as const,
        data: { content: 'Programmatic agent answer.' },
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        model: 'mock-agent',
        provider: 'mock',
        cost: 0,
      })) as AIService['generateWithUsage'],
    };
    const ctx = createTestContext({ ai, auth: { roles: ['user'] } });
    const chat = agentToolCallingChat();
    const session = await createSession(ctx, {
      chatName: chat.name,
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events: ChatEvent[] = [];

    for await (const event of runChatTurn(
      ctx,
      {
        chatDefinition: chat,
        sessionId: session.id,
        userMessage: 'A normal memoir answer.',
        audience: 'user',
        locale: 'en',
      },
      {
        resolveCapability: (name) => (name === readCap.name ? readCap : undefined),
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'message.delta', text: 'Programmatic agent answer.' });
    expect(events.at(-1)?.type).toBe('turn.completed');
  });

  it('fails clearly when toolCalling.ai runs on a core without per-call override support', async () => {
    const readCap = makeReadCap('readThing');
    const ai: AIService = { ...mockAI({ generate: inScopeAnswer }) };
    const generateWithUsage = vi.spyOn(ai, 'generateWithUsage');
    delete ai.features;
    const ctx = ctxWithCaps([readCap], { ai, auth: { roles: ['user'] } });
    const chat = defineChat({
      ...agentToolCallingChat(),
      policy: {
        toolCalling: {
          enabled: true,
          capabilities: ['readThing'],
          orchestration: 'agent',
          scopePreflight: false,
          ai: { model: 'tool-model' },
        },
      },
    });
    const session = await createSession(ctx, {
      chatName: chat.name,
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });

    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'A normal turn.',
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.failed',
        code: 'chat.core_version_unsupported',
        message: expect.stringContaining('@plumbus/core >= 0.6.18'),
      }),
    );
    expect(generateWithUsage).not.toHaveBeenCalled();
  });

  it('fails with chat.prompt_not_registered when registry is missing', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeAnswer }) });
    const chat = toolCallingChat();
    const session = await createSession(ctx, {
      chatName: 'toolchat',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'hi',
    });
    const failed = events[events.length - 1];
    expect(failed?.type).toBe('turn.failed');
    if (failed?.type === 'turn.failed') {
      expect(failed.code).toBe('chat.prompt_not_registered');
    }
  });

  it('fails with chat.prompt_not_registered when chat.toolRound is absent', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeAnswer }) });
    const chat = toolCallingChat();
    const session = await createSession(ctx, {
      chatName: 'toolchat',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'hi',
      registry: {
        hasPrompt: (name) => name === chatScopeCheckPrompt.name,
      },
    });
    const failed = events[events.length - 1];
    expect(failed?.type).toBe('turn.failed');
    if (failed?.type === 'turn.failed') {
      expect(failed.code).toBe('chat.prompt_not_registered');
    }
  });

  it('refuses off-topic at scope preflight without running tool rounds', async () => {
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: vi.fn(async (config) => {
        if (config.prompt === chatScopeCheckPrompt.name) {
          return {
            finishReason: 'stop',
            data: { inScope: false, refusalReason: 'off_topic' },
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            model: 'mock',
            provider: 'mock',
            cost: 0,
          };
        }
        throw new Error(`Unexpected prompt: ${String(config.prompt)}`);
      }),
    };
    const ctx = createTestContext({ ai });
    const chat = toolCallingChat(['readThing']);
    const session = await createSession(ctx, {
      chatName: 'toolchat',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'off topic',
      registry: allPromptsRegistry(),
    });
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed?.type).toBe('turn.completed');
    if (completed?.type === 'turn.completed') {
      expect(completed.inScope).toBe(false);
    }
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
  });

  it('runs the tool phase then answers and persists toolsExecuted', async () => {
    const readCap = makeReadCap('readThing');
    let toolRoundCalls = 0;
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: vi.fn(async (config) => {
        if (config.prompt === chatScopeCheckPrompt.name) {
          return {
            finishReason: 'stop',
            data: { inScope: true, refusalReason: null },
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            model: 'mock',
            provider: 'mock',
            cost: 0,
          };
        }
        if (config.prompt === 'chat.toolRound') {
          toolRoundCalls += 1;
          if (toolRoundCalls === 1) {
            const toolResult: AIToolCallsGenerateResult = {
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'tc1',
                  name: 'readThing',
                  argumentsStatus: 'parsed',
                  arguments: {},
                },
              ],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              model: 'mock',
              provider: 'mock',
              cost: 0.01,
            };
            return toolResult;
          }
          return {
            finishReason: 'stop',
            data: {},
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            model: 'mock',
            provider: 'mock',
            cost: 0,
          };
        }
        return mockAI({ generate: inScopeAnswer }).generateWithUsage(config);
      }),
    };
    const ctx = ctxWithCaps([readCap], {
      ai,
      auth: { roles: ['user'] },
    });
    const chat = toolCallingChat(['readThing']);
    const session = await createSession(ctx, {
      chatName: 'toolchat',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'lookup',
      registry: allPromptsRegistry(),
    });
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed?.type).toBe('turn.completed');
    if (completed?.type === 'turn.completed') {
      expect(completed.inScope).toBe(true);
    }
    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    const assistant = turns?.find((t) => t.role === 'assistant');
    expect(assistant?.toolsExecuted?.length).toBe(1);
  });

  it('coerces an off_topic answer back to in-scope after passing preflight (never unsafe/pii_request)', async () => {
    const offTopicAnswer = {
      inScope: false,
      answer: '',
      refusalReason: 'off_topic' as const,
      citedSources: [],
      requestedAction: null,
    };
    const piiAnswer = {
      inScope: false,
      answer: '',
      refusalReason: 'pii_request' as const,
      citedSources: [],
      requestedAction: null,
    };

    async function runWithAnswer(answer: typeof offTopicAnswer) {
      const ai: AIService = {
        ...mockAI({ generate: answer }),
        generateWithUsage: vi.fn(async (config) => {
          if (config.prompt === chatScopeCheckPrompt.name) {
            return {
              finishReason: 'stop',
              data: { inScope: true, refusalReason: null },
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
              model: 'mock',
              provider: 'mock',
              cost: 0,
            };
          }
          return mockAI({ generate: answer }).generateWithUsage(config);
        }),
      };
      const ctx = ctxWithCaps([], { ai });
      const chat = toolCallingChat([]);
      const session = await createSession(ctx, {
        chatName: 'toolchat',
        userId: ctx.auth.userId ?? 'u1',
        audience: 'user',
        locale: 'en',
      });
      return collectTurnEvents(ctx, chat, {
        sessionId: session.id,
        userMessage: 'q',
        registry: allPromptsRegistry(),
      });
    }

    const offTopicEvents = await runWithAnswer(offTopicAnswer);
    const offTopicCompleted = offTopicEvents.find((e) => e.type === 'turn.completed');
    expect(offTopicCompleted?.type).toBe('turn.completed');
    if (offTopicCompleted?.type === 'turn.completed') {
      expect(offTopicCompleted.inScope).toBe(true);
      expect(offTopicCompleted.refusalReason).toBeNull();
    }

    const piiEvents = await runWithAnswer(piiAnswer);
    const piiCompleted = piiEvents.find((e) => e.type === 'turn.completed');
    expect(piiCompleted?.type).toBe('turn.completed');
    if (piiCompleted?.type === 'turn.completed') {
      expect(piiCompleted.inScope).toBe(false);
      expect(piiCompleted.refusalReason).toBe('pii_request');
    }

    const unsafeAnswer = {
      inScope: false,
      answer: 'harmful content',
      refusalReason: 'unsafe' as const,
      citedSources: [],
      requestedAction: null,
    };
    const unsafeEvents = await runWithAnswer(unsafeAnswer);
    const unsafeCompleted = unsafeEvents.find((e) => e.type === 'turn.completed');
    expect(unsafeCompleted?.type).toBe('turn.completed');
    if (unsafeCompleted?.type === 'turn.completed') {
      expect(unsafeCompleted.inScope).toBe(false);
      expect(unsafeCompleted.refusalReason).toBe('unsafe');
    }
  });

  it('pauses with confirmation_required when the model calls a write (confirm-mode) tool', async () => {
    const writeCap = {
      ...makeReadCap('deleteAccount'),
      name: 'deleteAccount',
      effects: { data: ['users'], events: [], external: [], ai: false },
      handler: async () => ({ value: 'deleted' }),
    } as CapabilityContract;
    const toolCalls: AIToolCallsGenerateResult = {
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'tc-del',
          name: 'deleteAccount',
          argumentsStatus: 'parsed',
          arguments: {},
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'mock',
      provider: 'mock',
      cost: 0.01,
    };
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: vi.fn(async (config) => {
        if (config.prompt === chatScopeCheckPrompt.name) {
          return {
            finishReason: 'stop',
            data: { inScope: true, refusalReason: null },
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            model: 'mock',
            provider: 'mock',
            cost: 0,
          };
        }
        if (config.prompt === 'chat.toolRound') {
          return toolCalls;
        }
        return mockAI({ generate: inScopeAnswer }).generateWithUsage(config);
      }),
    };
    const ctx = ctxWithCaps([writeCap], { ai, auth: { roles: ['user'] } });
    const chat = toolCallingChat(['deleteAccount']);
    const session = await createSession(ctx, {
      chatName: 'toolchat',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'delete my account',
      registry: allPromptsRegistry(),
    });
    expect(events.some((e) => e.type === 'confirmation_required')).toBe(true);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
    const pending = await ctx.data.ChatPendingAction?.findMany({ sessionId: session.id });
    expect(pending?.length).toBe(1);
    expect(pending?.[0]?.status).toBe('pending');
  });

  it('emits a non-fatal chat.tool_round_limit notice and still completes', async () => {
    const readCap = makeReadCap('readThing');
    const alwaysToolCalls: AIToolCallsGenerateResult = {
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'tc-loop',
          name: 'readThing',
          argumentsStatus: 'parsed',
          arguments: {},
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'mock',
      provider: 'mock',
      cost: 0.01,
    };
    const ai: AIService = {
      ...mockAI({ generate: inScopeAnswer }),
      generateWithUsage: vi.fn(async (config) => {
        if (config.prompt === chatScopeCheckPrompt.name) {
          return {
            finishReason: 'stop',
            data: { inScope: true, refusalReason: null },
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            model: 'mock',
            provider: 'mock',
            cost: 0,
          };
        }
        if (config.prompt === 'chat.toolRound') {
          return alwaysToolCalls;
        }
        return mockAI({ generate: inScopeAnswer }).generateWithUsage(config);
      }),
    };
    const ctx = ctxWithCaps([readCap], {
      ai,
      auth: { roles: ['user'] },
    });
    const chat = defineChat({
      name: 'toolchat',
      access: {},
      instructions: ['x'],
      policy: {
        toolCalling: {
          enabled: true,
          capabilities: ['readThing'],
          maxToolRounds: 1,
        },
      },
    });
    const session = await createSession(ctx, {
      chatName: 'toolchat',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'loop',
      registry: allPromptsRegistry(),
    });
    expect(events.some((e) => e.type === 'notice' && e.code === 'chat.tool_round_limit')).toBe(
      true,
    );
    expect(events[events.length - 1]?.type).toBe('turn.completed');
  });

  it('leaves Path A single-shot behavior unchanged when toolCalling is absent', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeAnswer }) });
    const chat = defineChat({ name: 'pathA', access: {}, instructions: ['x'] });
    const session = await createSession(ctx, {
      chatName: 'pathA',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const events = await collectTurnEvents(ctx, chat, {
      sessionId: session.id,
      userMessage: 'hi',
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('message.delta');
    expect(types[types.length - 1]).toBe('turn.completed');
  });
});
