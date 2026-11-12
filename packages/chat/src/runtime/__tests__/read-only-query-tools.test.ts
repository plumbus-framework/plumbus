import type { AIService, CapabilityContract, ChatMessage } from '@plumbus/core';
import { definePrompt } from '@plumbus/core';
import { createTestContext, describe, expect, it, mockAI } from '@plumbus/core/testing';
import { z } from '@plumbus/core/zod';
import { defineChat } from '../../define/defineChat.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import type { ChatEvent } from '../../types/event.js';
import { bindChatCapabilityTools } from '../bind-tools.js';
import { isConfirmCapability } from '../tool-effects.js';
import { runChatTurn } from '../run-turn.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

/** A read-only app function: reads an earlier conversation (declares its data read). */
function readEarlierConversation(handler?: (input: { lessonId: string }) => unknown) {
  return {
    name: 'readEarlierConversation',
    kind: 'query',
    domain: 'test',
    description: 'Read the conversation of an earlier lesson',
    input: z.object({ lessonId: z.string() }),
    output: z.object({ messages: z.array(z.string()) }),
    effects: { data: ['Conversation'], events: [], external: [], ai: false },
    access: { roles: ['user'] },
    handler: async (_ctx: unknown, input: { lessonId: string }) =>
      handler ? handler(input) : { messages: [`earlier talk in ${input.lessonId}`] },
  } as unknown as CapabilityContract;
}

const tutorPrompt = definePrompt({
  name: 'test.tutor',
  domain: 'test',
  description: 'Tutor. Use the tool only for an earlier lesson.',
  input: z.object({}).passthrough(),
  output: z.object({ content: z.string() }),
});

function tutorChat(opts: { readOnlyQueries?: boolean; maxToolRounds?: number } = {}) {
  return defineChat({
    name: 'tutor',
    access: {},
    prompt: tutorPrompt,
    policy: {
      toolCalling: {
        enabled: true,
        orchestration: 'agent',
        capabilities: ['readEarlierConversation'],
        ...(opts.readOnlyQueries !== undefined ? { readOnlyQueries: opts.readOnlyQueries } : {}),
        ...(opts.maxToolRounds !== undefined ? { maxToolRounds: opts.maxToolRounds } : {}),
      },
    },
  });
}

describe('readOnlyQueries — tool classification', () => {
  it('a query with data effects is a confirm tool by default and an auto tool when opted in', () => {
    const cap = readEarlierConversation();
    expect(isConfirmCapability(cap)).toBe(true);
    expect(isConfirmCapability(cap, { readOnlyQueries: true })).toBe(false);
    const ctx = createTestContext();
    const bound = bindChatCapabilityTools(ctx, ['readEarlierConversation'], {
      maxTools: 4,
      resolveCapability: () => cap,
      readOnlyQueries: true,
    });
    expect(bound[0]?.mode).toBe('auto');
  });

  it('a query with event or external effects stays a confirm tool', () => {
    const cap = {
      ...readEarlierConversation(),
      effects: { data: ['Conversation'], events: ['x.happened'], external: [], ai: false },
    } as unknown as CapabilityContract;
    expect(isConfirmCapability(cap, { readOnlyQueries: true })).toBe(true);
  });

  it('an action with data effects stays a confirm tool', () => {
    const cap = { ...readEarlierConversation(), kind: 'action' } as unknown as CapabilityContract;
    expect(isConfirmCapability(cap, { readOnlyQueries: true })).toBe(true);
  });
});

describe('a read-only tool within a turn (agent orchestration)', () => {
  it('calls the tool, feeds its result back, and answers — bounded by maxToolRounds', async () => {
    const calls: Array<{ messages: ChatMessage[]; tools: unknown }> = [];
    const ai: AIService = {
      ...mockAI({}),
      generateWithUsage: (async (config: { messages?: ChatMessage[]; tools?: unknown }) => {
        calls.push({ messages: config.messages ?? [], tools: config.tools });
        if (calls.length === 1) {
          return {
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call-1',
                name: 'readEarlierConversation',
                arguments: { lessonId: 'L1' },
                argumentsStatus: 'valid',
              },
            ],
            data: null,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            model: 'm',
            provider: 'p',
            cost: 0,
          };
        }
        return {
          finishReason: 'stop',
          data: { content: 'In lesson 1 you said X.' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          model: 'm',
          provider: 'p',
          cost: 0,
        };
      }) as unknown as AIService['generateWithUsage'],
    };
    const ctx = createTestContext({ auth: { userId: 'u1', roles: ['user'] }, ai });
    const cap = readEarlierConversation();
    const events: ChatEvent[] = [];
    for await (const evt of runChatTurn(
      ctx,
      {
        chatDefinition: tutorChat({ readOnlyQueries: true, maxToolRounds: 2 }),
        sessionId: SESSION_ID,
        userMessage: 'What did I say in lesson 1?',
        audience: 'user',
        locale: 'en',
      },
      { sessionStore: createInMemoryChatSessionStore(), resolveCapability: () => cap },
    )) {
      events.push(evt);
    }

    expect(calls).toHaveLength(2);
    const toolMessage = calls[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('earlier talk in L1');
    expect(events.map((e) => e.type)).toContain('tool.completed');
    expect(events).toContainEqual({ type: 'message.delta', text: 'In lesson 1 you said X.' });
    expect(events.at(-1)?.type).toBe('turn.completed');
    expect(events.some((e) => e.type === 'confirmation_required')).toBe(false);
  });

  it('without readOnlyQueries the same query would pause for confirmation (not run)', async () => {
    let ran = false;
    const cap = readEarlierConversation(() => {
      ran = true;
      return { messages: [] };
    });
    const ai: AIService = {
      ...mockAI({}),
      generateWithUsage: (async () => ({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            name: 'readEarlierConversation',
            arguments: { lessonId: 'L1' },
            argumentsStatus: 'valid',
          },
        ],
        data: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'm',
        provider: 'p',
        cost: 0,
      })) as unknown as AIService['generateWithUsage'],
    };
    const ctx = createTestContext({ auth: { userId: 'u1', roles: ['user'] }, ai });
    for await (const _evt of runChatTurn(
      ctx,
      {
        chatDefinition: tutorChat(),
        sessionId: SESSION_ID,
        userMessage: 'What did I say?',
        audience: 'user',
        locale: 'en',
      },
      { sessionStore: createInMemoryChatSessionStore(), resolveCapability: () => cap },
    )) {
      // drain
    }
    expect(ran).toBe(false);
  });
});
