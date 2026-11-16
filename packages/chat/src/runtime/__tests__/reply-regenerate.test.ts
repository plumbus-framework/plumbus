import type { AIService } from '@plumbus/core';
import { describe, expect, it, mockAI, vi } from '@plumbus/core/testing';
import { z } from '@plumbus/core/zod';
import { defineChat } from '../../define/defineChat.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import { mockChatRuntime } from '../../testing/mock-chat-runtime.js';
import type { ChatEvent } from '../../types/event.js';
import type { Guard } from '../../types/policy.js';
import type {
  ChatReplyValidationContext,
  ChatReplyValidator,
  ChatReplyVerdict,
} from '../../types/reply.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const INPUT = { sessionId: SESSION_ID, userMessage: 'hello', audience: 'user', locale: 'en' };

function output(answer: string, extra: Record<string, unknown> = {}) {
  return {
    inScope: true,
    answer,
    refusalReason: null,
    citedSources: [],
    requestedAction: null,
    ...extra,
  };
}

interface RecordedCall {
  method: 'streamGenerate' | 'generateWithUsage';
  config: Record<string, unknown>;
}

/**
 * A mock AI that answers each model call with the next output in `outputs`,
 * through the stream (the runtime's first choice), and records every call with
 * its usage: 10 tokens in, 5 out and $0.01 per call.
 */
function sequenceAI(outputs: Array<Record<string, unknown> | Error>): {
  ai: AIService;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const next = () => {
    const out = outputs.shift();
    if (out === undefined) throw new Error('sequenceAI: no output left');
    if (out instanceof Error) throw out;
    return out;
  };
  const ai: AIService = {
    ...mockAI({}),
    async *streamGenerate(config: Record<string, unknown>) {
      calls.push({ method: 'streamGenerate', config });
      const data = next();
      yield {
        type: 'done' as const,
        data,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: `model-${calls.length}`,
        provider: 'mock',
        cost: 0.01,
      };
    },
    generateWithUsage: (async (config: Record<string, unknown>) => {
      calls.push({ method: 'generateWithUsage', config });
      return {
        finishReason: 'stop',
        data: next(),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: `model-${calls.length}`,
        provider: 'mock',
        cost: 0.01,
      };
    }) as unknown as AIService['generateWithUsage'],
  } as AIService;
  return { ai, calls };
}

async function run(
  chat: ReturnType<typeof defineChat>,
  outputs: Array<Record<string, unknown> | Error>,
  opts: { validateReply?: ChatReplyValidator; maxRegenerations?: number } = {},
) {
  const { ai, calls } = sequenceAI(outputs);
  const sessionStore = createInMemoryChatSessionStore();
  const { events } = await mockChatRuntime(
    chat,
    INPUT,
    { auth: { userId: 'u1', roles: ['user'] }, ai },
    { sessionStore, ...opts },
  );
  return {
    events,
    calls,
    assistant: sessionStore.__turns.filter((t) => t.role === 'assistant'),
    byType: <T extends ChatEvent['type']>(type: T) =>
      events.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type),
    completed: events.find((e) => e.type === 'turn.completed') as
      | Extract<ChatEvent, { type: 'turn.completed' }>
      | undefined,
  };
}

const chat = defineChat({ name: 'regen', access: {}, instructions: ['x'] });

/** Regenerate every draft whose text is not `good`, recording what the validator saw. */
function regenerateUntilGood(
  seen: ChatReplyValidationContext['regeneration'][],
): ChatReplyValidator {
  return (reply, turn) => {
    seen.push(turn.regeneration);
    if (reply.text === 'good') {
      return turn.regeneration.attempt > 0
        ? { decision: 'accept', code: 'app.too_long|retry-passed' }
        : { decision: 'accept' };
    }
    return {
      decision: 'regenerate',
      feedback: 'Too long: write it again, shorter.',
      code: 'app.too_long',
      fallback: { text: '', code: `app.too_long|retried:${turn.regeneration.attempt}` },
    } satisfies ChatReplyVerdict;
  };
}

describe('validateReply regenerate', () => {
  it('asks the model again with the draft and the feedback, then accepts the new reply', async () => {
    const seen: ChatReplyValidationContext['regeneration'][] = [];
    const r = await run(chat, [output('too long draft'), output('good')], {
      validateReply: regenerateUntilGood(seen),
    });

    expect(seen).toEqual([
      { attempt: 0, remaining: 1 },
      { attempt: 1, remaining: 0 },
    ]);
    expect(r.calls).toHaveLength(2);
    const second = r.calls[1]?.config;
    // Same prompt and prompt input; the draft and the feedback follow the turn's thread.
    expect(second.prompt).toBe(r.calls[0]?.config.prompt);
    expect(second.input).toEqual(r.calls[0]?.config.input);
    expect(second.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: JSON.stringify(output('too long draft')) },
      { role: 'user', content: 'Too long: write it again, shorter.' },
    ]);
    expect(second.costContext).toEqual({
      serviceArea: 'chat',
      operationName: 'chat.regen.regenerate',
    });

    expect(r.assistant).toHaveLength(1);
    expect(r.assistant[0]?.content).toBe('good');
    expect(r.assistant[0]?.moderation).toEqual({ code: 'app.too_long|retry-passed' });
    expect(r.completed?.moderation).toEqual({ code: 'app.too_long|retry-passed' });
    expect(JSON.stringify(r.assistant)).not.toContain('too long draft');
  });

  it('streams the new draft with message.replaced so the client withdraws the first', async () => {
    const r = await run(chat, [output('too long draft'), output('good')], {
      validateReply: regenerateUntilGood([]),
    });
    expect(r.events.map((e) => e.type)).toEqual([
      'turn.started',
      'message.delta',
      'message.replaced',
      'turn.completed',
    ]);
    expect(r.byType('message.delta')[0]).toEqual({ type: 'message.delta', text: 'too long draft' });
    expect(r.byType('message.replaced')[0]).toEqual({
      type: 'message.replaced',
      text: 'good',
      code: 'app.too_long',
    });
  });

  it('counts every regeneration call in the turn usage, cost and regenerations', async () => {
    const r = await run(chat, [output('too long draft'), output('good')], {
      validateReply: regenerateUntilGood([]),
    });
    expect(r.completed).toMatchObject({
      usage: { tokensIn: 20, tokensOut: 10 },
      model: 'model-2',
      regenerations: 1,
    });
    expect(r.completed?.cost).toBeCloseTo(0.02);
    expect(r.assistant[0]).toMatchObject({ tokensIn: 20, tokensOut: 10, model: 'model-2' });
    expect(r.assistant[0]?.costUsd).toBeCloseTo(0.02);
  });

  it('replaces with the fallback when the budget is spent (default maxRegenerations 1)', async () => {
    const seen: ChatReplyValidationContext['regeneration'][] = [];
    const r = await run(chat, [output('too long draft'), output('still too long')], {
      validateReply: regenerateUntilGood(seen),
    });
    expect(r.calls).toHaveLength(2);
    expect(seen).toEqual([
      { attempt: 0, remaining: 1 },
      { attempt: 1, remaining: 0 },
    ]);
    expect(r.byType('message.replaced')).toEqual([
      { type: 'message.replaced', text: 'still too long', code: 'app.too_long' },
      { type: 'message.replaced', text: '', code: 'app.too_long|retried:1' },
    ]);
    expect(r.assistant[0]?.content).toBe('');
    expect(r.assistant[0]?.moderation).toEqual({ code: 'app.too_long|retried:1' });
    expect(r.completed).toMatchObject({
      moderation: { code: 'app.too_long|retried:1' },
      regenerations: 1,
      usage: { tokensIn: 20, tokensOut: 10 },
    });
  });

  it('honors maxRegenerations: 0 (no extra call) and 2 (two extra calls)', async () => {
    const none = await run(chat, [output('bad')], {
      validateReply: regenerateUntilGood([]),
      maxRegenerations: 0,
    });
    expect(none.calls).toHaveLength(1);
    expect(none.assistant[0]?.moderation).toEqual({ code: 'app.too_long|retried:0' });
    expect(none.completed).not.toHaveProperty('regenerations');

    const two = await run(chat, [output('bad'), output('bad again'), output('good')], {
      validateReply: regenerateUntilGood([]),
      maxRegenerations: 2,
    });
    expect(two.calls).toHaveLength(3);
    expect(two.calls[2]?.config.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: JSON.stringify(output('bad')) },
      { role: 'user', content: 'Too long: write it again, shorter.' },
      { role: 'assistant', content: JSON.stringify(output('bad again')) },
      { role: 'user', content: 'Too long: write it again, shorter.' },
    ]);
    expect(two.assistant[0]?.content).toBe('good');
    expect(two.completed).toMatchObject({
      regenerations: 2,
      usage: { tokensIn: 30, tokensOut: 15 },
    });
  });

  it('a failed regeneration call ends in the fallback with a notice', async () => {
    const r = await run(
      chat,
      [output('bad'), new Error('provider down'), new Error('provider down')],
      {
        validateReply: regenerateUntilGood([]),
      },
    );
    // The stream threw, then the non-stream call threw.
    expect(r.calls.map((c) => c.method)).toEqual([
      'streamGenerate',
      'streamGenerate',
      'generateWithUsage',
    ]);
    expect(r.byType('notice')).toContainEqual(
      expect.objectContaining({ code: 'chat.regeneration_failed' }),
    );
    expect(r.assistant[0]?.content).toBe('');
    expect(r.assistant[0]?.moderation).toEqual({ code: 'app.too_long|retried:0' });
    expect(r.byType('turn.completed')).toHaveLength(1);
  });

  it('a regeneration past the per-turn cost cap ends in the fallback (chat.budget_exceeded)', async () => {
    const capped = defineChat({
      name: 'capped',
      access: {},
      instructions: ['x'],
      budget: { perTurn: { costUsd: 0.015 } },
    });
    const r = await run(capped, [output('bad'), output('good')], {
      validateReply: regenerateUntilGood([]),
    });
    expect(r.calls).toHaveLength(2);
    expect(r.byType('notice')).toContainEqual(
      expect.objectContaining({ code: 'chat.budget_exceeded' }),
    );
    expect(r.assistant[0]?.content).toBe('');
    expect(r.completed?.cost).toBeCloseTo(0.02);
  });

  it('an invalid regenerate verdict (no fallback) fails the turn closed', async () => {
    const r = await run(chat, [output('bad')], {
      validateReply: () =>
        ({
          decision: 'regenerate',
          feedback: 'again',
          code: 'app.x',
        }) as unknown as ChatReplyVerdict,
    });
    expect(r.calls).toHaveLength(1);
    expect(r.assistant).toHaveLength(0);
    expect(r.byType('turn.failed')[0]).toMatchObject({ code: 'chat.reply_validation_failed' });
  });

  it('runs the post-turn guards on the regenerated draft', async () => {
    const guarded: string[] = [];
    const watch: Guard = async (_t, state) => {
      guarded.push(String(state.modelOutput?.answer));
      if (state.modelOutput?.answer === 'good secret') state.modelOutput.answer = 'good';
      return { decision: 'allow' };
    };
    const watched = defineChat({
      name: 'watched',
      access: {},
      instructions: ['x'],
      policy: { customPostTurn: [watch] },
    });
    const r = await run(watched, [output('bad'), output('good secret')], {
      validateReply: regenerateUntilGood([]),
    });
    expect(guarded).toEqual(['bad', 'good secret']);
    expect(r.assistant[0]?.content).toBe('good');
    // The guarded new draft is what the client was shown; nothing more is replaced.
    expect(r.byType('message.replaced')).toEqual([
      { type: 'message.replaced', text: 'good', code: 'app.too_long' },
    ]);
  });

  it('regenerates an agent-orchestration answer on its own thread, without tools', async () => {
    const agentChat = defineChat({
      name: 'agentRegen',
      access: {},
      prompt: { name: 'app.agent' } as never,
      policy: { toolCalling: { enabled: true, orchestration: 'agent', capabilities: [] } },
    });
    const { ai, calls } = sequenceAI([{ content: 'bad' }, { content: 'good' }]);
    const agentOutputs: unknown[] = [];
    const { events } = await mockChatRuntime(
      agentChat,
      INPUT,
      { auth: { userId: 'u1', roles: ['user'] }, ai },
      {
        sessionStore: createInMemoryChatSessionStore(),
        resolveCapability: () => undefined,
        onAgentOutput: (o) => agentOutputs.push(o),
        validateReply: regenerateUntilGood([]),
      },
    );
    expect(calls.map((c) => c.method)).toEqual(['generateWithUsage', 'generateWithUsage']);
    expect(calls[1]?.config).not.toHaveProperty('tools');
    expect(calls[1]?.config.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: JSON.stringify({ content: 'bad' }) },
      { role: 'user', content: 'Too long: write it again, shorter.' },
    ]);
    expect(agentOutputs).toEqual([{ content: 'bad' }, { content: 'good' }]);
    expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({ regenerations: 1 });
  });
});

describe('answerOf — a custom prompt names its own answer text', () => {
  const partsPrompt = {
    name: 'app.parts',
    output: z.object({
      inScope: z.boolean(),
      parts: z.array(z.object({ text: z.string() })),
      refusalReason: z.null(),
      citedSources: z.array(z.string()),
      requestedAction: z.null(),
    }),
  } as never;
  const partsOf = (o: unknown) =>
    ((o as { parts?: Array<{ text: string }> }).parts ?? []).map((p) => p.text).join('\n');
  const partsOutput = (...texts: string[]) => ({
    inScope: true,
    parts: texts.map((text) => ({ text })),
    refusalReason: null,
    citedSources: [],
    requestedAction: null,
  });

  it('streams, validates and persists the text answerOf reads; the raw output reaches validateReply', async () => {
    const partsChat = defineChat({
      name: 'parts',
      access: {},
      instructions: ['x'],
      prompt: partsPrompt,
      answerOf: partsOf,
    });
    const seen: { text: string; modelOutput: unknown }[] = [];
    const r = await run(partsChat, [partsOutput('First.', 'Second?')], {
      validateReply: (reply) => {
        seen.push({ text: reply.text, modelOutput: reply.modelOutput });
        return { decision: 'accept' };
      },
    });
    expect(r.byType('message.delta')[0]?.text).toBe('First.\nSecond?');
    expect(r.assistant[0]?.content).toBe('First.\nSecond?');
    expect(seen).toEqual([
      { text: 'First.\nSecond?', modelOutput: partsOutput('First.', 'Second?') },
    ]);
  });

  it('reads the regenerated draft through answerOf too', async () => {
    const partsChat = defineChat({
      name: 'partsRegen',
      access: {},
      instructions: ['x'],
      prompt: partsPrompt,
      answerOf: partsOf,
    });
    const r = await run(partsChat, [partsOutput('bad'), partsOutput('good')], {
      validateReply: regenerateUntilGood([]),
    });
    expect(r.calls[1]?.config.messages).toContainEqual({
      role: 'assistant',
      content: JSON.stringify(partsOutput('bad')),
    });
    expect(r.assistant[0]?.content).toBe('good');
  });

  it('does not warn about a missing answer field when answerOf is given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      defineChat({
        name: 'quiet',
        access: {},
        instructions: ['x'],
        prompt: { ...(partsPrompt as object), name: 'app.quiet' } as never,
        answerOf: partsOf,
      });
      expect(warn.mock.calls.flat().join(' ')).not.toContain('missing base fields');
      defineChat({
        name: 'loud',
        access: {},
        instructions: ['x'],
        prompt: { ...(partsPrompt as object), name: 'app.loud' } as never,
      });
      expect(warn.mock.calls.flat().join(' ')).toContain(
        'custom prompt "app.loud" output schema missing base fields: answer',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('requires a custom prompt', () => {
    expect(() =>
      defineChat({ name: 'noPrompt', access: {}, instructions: ['x'], answerOf: partsOf }),
    ).toThrow(/answerOf .* requires `prompt`/);
  });

  it('a non-string answerOf result fails the turn', async () => {
    const broken = defineChat({
      name: 'broken',
      access: {},
      instructions: ['x'],
      prompt: { ...(partsPrompt as object), name: 'app.broken' } as never,
      answerOf: (() => 42) as never,
    });
    const r = await run(broken, [partsOutput('x')]);
    expect(r.assistant).toHaveLength(0);
    expect(r.byType('turn.failed')[0]).toMatchObject({ code: 'chat.turn_error' });
  });

  it('keeps the base answer field as the default', async () => {
    const r = await run(chat, [output('plain answer')]);
    expect(r.assistant[0]?.content).toBe('plain answer');
  });
});
