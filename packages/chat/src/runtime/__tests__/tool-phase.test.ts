import { describe, expect, it, vi } from 'vitest';
import { z } from '@plumbus/core/zod';
import type {
  AIToolCall,
  AIToolCallsGenerateResult,
  AIToolEnabledGenerateResult,
  AIService,
  CapabilityContract,
  ExecutionContext,
} from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { bindChatCapabilityTools } from '../bind-tools.js';
import { runToolPhase } from '../tool-phase.js';
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

function makeCap(name: string, overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain: 'test',
    input: z.object({ q: z.string().optional() }),
    output: z.object({ value: z.string() }),
    effects: { data: [], events: [], external: [], ai: true },
    access: { roles: ['user'] },
    handler: async () => ({ value: 'ok' }),
    ...overrides,
  } as CapabilityContract;
}

function parsedCall(id: string, name: string, args: unknown): AIToolCall {
  return { id, name, argumentsStatus: 'parsed', arguments: args };
}

function invalidCall(id: string, name: string): AIToolCall {
  return {
    id,
    name,
    argumentsStatus: 'invalid',
    rawArguments: 'LEAK_ME_RAW',
    parseError: 'LEAK_ME_PARSE',
  };
}

function toolCallsResult(toolCalls: AIToolCall[]): AIToolCallsGenerateResult {
  return {
    finishReason: 'tool_calls',
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'mock',
    provider: 'mock',
    cost: 0.01,
  };
}

function createScriptedAI(script: AIToolEnabledGenerateResult[]): {
  ai: AIService;
  capturedTools: unknown[][];
} {
  let index = 0;
  const capturedTools: unknown[][] = [];
  const ai: AIService = {
    async recordProviderCost() {},
    checkProviderCostBudget() {},
    async generate() {
      return {};
    },
    generateWithUsage: vi.fn(async (config) => {
      if ('tools' in config && config.tools) {
        capturedTools.push(config.tools as unknown[]);
      }
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`Unexpected generateWithUsage call #${index}`);
      }
      return next;
    }),
    async *streamGenerate() {
      yield { type: 'done' as const, data: {} };
    },
    async extract() {
      return {};
    },
    async classify() {
      return [];
    },
    async retrieve() {
      return [];
    },
  };
  return { ai, capturedTools };
}

describe('runToolPhase', () => {
  it('executes an auto tool and emits tool.started then tool.completed', async () => {
    const cap = makeCap('readThing');
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('tc1', 'readThing', { q: 'hi' })]),
      {
        finishReason: 'stop',
        data: {},
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: 'm',
        provider: 'mock',
        cost: 0,
      },
    ]);
    const ctx = ctxWithCaps([cap], { ai, auth: { roles: ['user'] } });
    const bound = bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    const events: ChatEvent[] = [];
    const result = await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'hello',
      history: [],
      maxToolRounds: 5,
      emit: (e) => events.push(e),
    });

    const started = events.filter((e) => e.type === 'tool.started');
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(started[0]?.type).toBe('tool.started');
    expect(completed[0]?.type).toBe('tool.completed');
    if (started[0]?.type === 'tool.started' && completed[0]?.type === 'tool.completed') {
      expect(started[0].toolCallId).toBe('tc1');
      expect(completed[0].toolCallId).toBe('tc1');
    }
    expect(result.toolsExecuted[0]?.status).toBe('completed');
  });

  it('records not_executed with chat.tool_arguments_invalid for invalid arguments and never leaks rawArguments', async () => {
    const cap = makeCap('readThing');
    const { ai } = createScriptedAI([
      toolCallsResult([invalidCall('tc-bad', 'readThing')]),
      {
        finishReason: 'stop',
        data: {},
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: 'm',
        provider: 'mock',
        cost: 0,
      },
    ]);
    const ctx = ctxWithCaps([cap], { ai, auth: { roles: ['user'] } });
    const bound = bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    const events: ChatEvent[] = [];
    const result = await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'hello',
      history: [],
      maxToolRounds: 5,
      emit: (e) => events.push(e),
    });

    expect(result.toolsExecuted[0]?.errorCode).toBe('chat.tool_arguments_invalid');
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('LEAK_ME_RAW');
    expect(serialized).not.toContain('LEAK_ME_PARSE');
    expect(serialized).not.toContain('rawArguments');
    expect(serialized).not.toContain('parseError');
  });

  it('maps a forbidden capability failure to chat.tool_access_denied', async () => {
    const cap = makeCap('readThing', { access: { roles: ['admin'] } });
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('tc-deny', 'readThing', {})]),
      {
        finishReason: 'stop',
        data: {},
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: 'm',
        provider: 'mock',
        cost: 0,
      },
    ]);
    const ctx = ctxWithCaps([cap], { ai, auth: { roles: ['user'] } });
    const bound = bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    const events: ChatEvent[] = [];
    await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'hello',
      history: [],
      maxToolRounds: 5,
      emit: (e) => events.push(e),
    });

    const failed = events.find((e) => e.type === 'tool.failed');
    expect(failed?.type).toBe('tool.failed');
    if (failed?.type === 'tool.failed') {
      expect(failed.code).toBe('chat.tool_access_denied');
    }
  });

  it('sets roundLimitReached true when the model keeps calling tools past maxToolRounds', async () => {
    const cap = makeCap('readThing');
    const alwaysTools = toolCallsResult([parsedCall('tc-loop', 'readThing', {})]);
    const { ai } = createScriptedAI([alwaysTools, alwaysTools, alwaysTools]);
    const ctx = ctxWithCaps([cap], { ai, auth: { roles: ['user'] } });
    const bound = bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    const result = await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'hello',
      history: [],
      maxToolRounds: 1,
      emit: () => {},
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.roundLimitReached).toBe(true);
    }
  });

  it('presents confirm-mode tools to the provider and pauses without executing', async () => {
    const confirmCap = makeCap('writeThing', {
      effects: { data: ['x'], events: [], external: [], ai: false },
    });
    const { ai, capturedTools } = createScriptedAI([
      toolCallsResult([parsedCall('tc-write', 'writeThing', { q: 'go' })]),
    ]);
    const ctx = ctxWithCaps([confirmCap], { ai, auth: { roles: ['user'] } });
    const bound = bindChatCapabilityTools(ctx, ['writeThing'], { maxTools: 32 });
    const events: ChatEvent[] = [];
    const result = await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'delete it',
      history: [],
      maxToolRounds: 5,
      emit: (e) => events.push(e),
    });
    expect(capturedTools[0]?.map((t: { name: string }) => t.name)).toContain('writeThing');
    expect(result.status).toBe('paused');
    if (result.status === 'paused') {
      expect(result.pause.bound.mode).toBe('confirm');
      expect(result.pause.toolCallId).toBe('tc-write');
      const assistant = result.pause.exchange.find(
        (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'tc-write'),
      );
      expect(assistant).toBeDefined();
    }
    expect(result.toolsExecuted[0]?.status).toBe('confirm_pending');
    expect(events.some((e) => e.type === 'tool.completed')).toBe(false);
  });

  it('serializes BigInt tool results without throwing', async () => {
    const cap = makeCap('readThing', {
      handler: async () => ({ value: BigInt(42) }),
      output: z.object({ value: z.bigint() }),
    });
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('tc-big', 'readThing', {})]),
      {
        finishReason: 'stop',
        data: {},
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: 'm',
        provider: 'mock',
        cost: 0,
      },
    ]);
    const ctx = ctxWithCaps([cap], { ai, auth: { roles: ['user'] } });
    const bound = bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    const result = await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'hello',
      history: [],
      maxToolRounds: 5,
      emit: () => {},
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.observationsForAnswer).toContain('42');
    }
  });

  it('presents both auto and confirm tools to the provider', async () => {
    const autoCap = makeCap('readAuto');
    const confirmCap = makeCap('writeConfirm', {
      effects: { data: ['x'], events: [], external: [], ai: false },
    });
    const { ai, capturedTools } = createScriptedAI([
      toolCallsResult([parsedCall('tc1', 'readAuto', {})]),
      {
        finishReason: 'stop',
        data: {},
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: 'm',
        provider: 'mock',
        cost: 0,
      },
    ]);
    const ctx = ctxWithCaps([autoCap, confirmCap], {
      ai,
      auth: { roles: ['user'] },
    });
    const bound = bindChatCapabilityTools(ctx, ['readAuto', 'writeConfirm'], { maxTools: 32 });
    await runToolPhase({
      ctx,
      chatName: 'test',
      boundTools: bound,
      systemPrompt: 'sys',
      userMessage: 'hello',
      history: [],
      maxToolRounds: 5,
      emit: () => {},
    });
    expect(capturedTools.length).toBeGreaterThan(0);
    for (const tools of capturedTools) {
      const toolNames = (tools as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).toContain('readAuto');
      expect(toolNames).toContain('writeConfirm');
    }
  });
});
