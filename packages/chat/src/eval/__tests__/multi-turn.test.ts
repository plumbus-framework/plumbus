import type { AIService } from '@plumbus/core';
import { createTestContext, describe, expect, it, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import {
  type ChatEvalTurnRecord,
  defineChatEvaluation,
} from '../../define/defineChatEvaluation.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import { promptJudge, promptUserSimulator } from '../model-helpers.js';
import { checkAssertion, runChatEvaluation } from '../run-evaluation.js';

const SESSION = '77777777-7777-4777-8777-777777777777';

function reply(text: string, extra: Record<string, unknown> = {}) {
  return {
    inScope: true,
    answer: text,
    refusalReason: null,
    citedSources: [],
    requestedAction: null,
    ...extra,
  };
}

/**
 * Scripted model: `chat.turn`-style prompts get the next reply in order;
 * other prompts (persona / judge) get their own scripted outputs.
 */
function scriptedAI(opts: {
  replies: string[];
  persona?: Array<{ message: string | null }>;
  judge?: { pass: boolean; reason?: string };
  onTurnInput?: (input: Record<string, unknown>) => void;
}) {
  let r = 0;
  let p = 0;
  const personaInputs: Record<string, unknown>[] = [];
  const judgeInputs: Record<string, unknown>[] = [];
  const base = mockAI({});
  const ai: AIService = {
    ...base,
    async *streamGenerate(cfg) {
      opts.onTurnInput?.(cfg.input as Record<string, unknown>);
      const data = reply(opts.replies[r++] ?? 'out of script');
      yield {
        type: 'done' as const,
        data,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    generateWithUsage: (async (cfg: { prompt: string; input: Record<string, unknown> }) => {
      let data: unknown;
      if (cfg.prompt === 'eval.persona') {
        personaInputs.push(cfg.input);
        data = opts.persona?.[p++] ?? { message: null };
      } else if (cfg.prompt === 'eval.judge') {
        judgeInputs.push(cfg.input);
        data = opts.judge ?? { pass: true };
      } else {
        data = reply(opts.replies[r++] ?? 'out of script');
      }
      return {
        finishReason: 'stop',
        data,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'm',
        provider: 'p',
        cost: 0,
      };
    }) as unknown as AIService['generateWithUsage'],
  };
  return { ai, personaInputs, judgeInputs };
}

const chat = defineChat({ name: 'evalChat', access: {}, instructions: ['x'] });

function ctxWith(ai: AIService) {
  return createTestContext({ auth: { userId: 'u1', roles: ['user'] }, ai });
}

describe('runChatEvaluation — scripted multi-turn', () => {
  it('runs every turn on one session, with history, per-turn and last-turn assertions', async () => {
    const historyLengths: number[] = [];
    const { ai } = scriptedAI({
      replies: ['First.', 'Second.', 'Third.'],
      onTurnInput: (input) => historyLengths.push((input.history as unknown[]).length),
    });
    const evaluation = defineChatEvaluation({
      name: 'scripted',
      chat,
      scenarios: [
        {
          name: 'three turns',
          given: {},
          when: {
            turns: [
              { send: 'one' },
              { send: 'two', then: [{ type: 'expectCompletedInScope', value: true }] },
              { send: 'three' },
            ],
          },
          perTurn: { then: [{ type: 'expectTurnCompleted' }] },
          then: [{ type: 'expectCompletedRefusalReason', value: null }],
        },
      ],
    });
    const [result] = await runChatEvaluation(evaluation, ctxWith(ai), {
      sessionId: SESSION,
      audience: 'user',
      locale: 'en',
      stores: { sessionStore: createInMemoryChatSessionStore() },
    });
    expect(result?.failures).toEqual([]);
    expect(result?.passed).toBe(true);
    expect(result?.transcript?.map((t) => [t.userMessage, t.reply])).toEqual([
      ['one', 'First.'],
      ['two', 'Second.'],
      ['three', 'Third.'],
    ]);
    // The model saw a growing server-persisted history.
    expect(historyLengths).toEqual([0, 2, 4]);
  });

  it('reports which turn failed an assertion', async () => {
    const { ai } = scriptedAI({ replies: ['a', 'b'] });
    const evaluation = defineChatEvaluation({
      name: 'failing',
      chat,
      scenarios: [
        {
          name: 'expects a failure that does not happen',
          given: {},
          when: { turns: [{ send: 'one' }, { send: 'two', then: [{ type: 'expectTurnFailed' }] }] },
          then: [],
        },
      ],
    });
    const [result] = await runChatEvaluation(evaluation, ctxWith(ai), {
      sessionId: SESSION,
      audience: 'user',
      locale: 'en',
      stores: { sessionStore: createInMemoryChatSessionStore() },
    });
    expect(result?.passed).toBe(false);
    expect(result?.failures[0]).toMatch(/^turn 2: Assertion failed/);
  });

  it('per-turn and conversation judges run; a failing judge fails the scenario with its reason', async () => {
    const { ai } = scriptedAI({ replies: ['a', 'b'] });
    const turnsJudged: number[] = [];
    const evaluation = defineChatEvaluation({
      name: 'judged',
      chat,
      scenarios: [
        {
          name: 'judges',
          given: {},
          when: { turns: [{ send: 'one' }, { send: 'two' }] },
          then: [],
          perTurn: {
            judge: ({ turn }) => {
              turnsJudged.push(turn.index);
              return { pass: true };
            },
          },
          judge: ({ transcript }) => ({
            pass: transcript.length === 3,
            reason: `saw ${transcript.length} turns`,
          }),
        },
      ],
    });
    const [result] = await runChatEvaluation(evaluation, ctxWith(ai), {
      sessionId: SESSION,
      audience: 'user',
      locale: 'en',
      stores: { sessionStore: createInMemoryChatSessionStore() },
    });
    expect(turnsJudged).toEqual([0, 1]);
    expect(result?.failures).toEqual(['conversation judge failed: saw 2 turns']);
  });

  it('turnInputs supplies server-owned prompt input per turn', async () => {
    const seen: unknown[] = [];
    const { ai } = scriptedAI({ replies: ['a', 'b'], onTurnInput: (i) => seen.push(i.lesson) });
    const evaluation = defineChatEvaluation({
      name: 'inputs',
      chat,
      scenarios: [
        { name: 's', given: {}, when: { turns: [{ send: '1' }, { send: '2' }] }, then: [] },
      ],
    });
    await runChatEvaluation(evaluation, ctxWith(ai), {
      sessionId: SESSION,
      audience: 'user',
      locale: 'en',
      stores: { sessionStore: createInMemoryChatSessionStore() },
      turnInputs: ({ turnIndex }) => ({ promptInput: { lesson: `L${turnIndex + 1}` } }),
    });
    expect(seen).toEqual(['L1', 'L2']);
  });
});

describe('runChatEvaluation — simulated user', () => {
  it('a function persona writes each next turn until maxTurns', async () => {
    const { ai } = scriptedAI({ replies: ['r1', 'r2', 'r3', 'r4'] });
    const evaluation = defineChatEvaluation({
      name: 'sim',
      chat,
      scenarios: [
        {
          name: 'persona',
          given: {},
          when: {
            simulate: {
              opening: 'hello',
              maxTurns: 3,
              user: ({ transcript }: { transcript: ChatEvalTurnRecord[] }) =>
                `follow-up to ${transcript.at(-1)?.reply}`,
            },
          },
          then: [{ type: 'expectTurnCompleted' }],
        },
      ],
    });
    const [result] = await runChatEvaluation(evaluation, ctxWith(ai), {
      sessionId: SESSION,
      audience: 'user',
      locale: 'en',
      stores: { sessionStore: createInMemoryChatSessionStore() },
    });
    expect(result?.passed).toBe(true);
    expect(result?.transcript?.map((t) => t.userMessage)).toEqual([
      'hello',
      'follow-up to r1',
      'follow-up to r2',
    ]);
  });

  it('promptUserSimulator: an app persona prompt writes turns and ends with null; promptJudge judges', async () => {
    const { ai, personaInputs, judgeInputs } = scriptedAI({
      replies: ['Answer one.', 'Answer two.'],
      persona: [{ message: 'I am confused <script>' }, { message: 'Thanks' }, { message: null }],
      judge: { pass: false, reason: 'too long' },
    });
    const evaluation = defineChatEvaluation({
      name: 'model-sim',
      chat,
      scenarios: [
        {
          name: 'model persona',
          given: {},
          when: {
            simulate: {
              maxTurns: 5,
              user: promptUserSimulator({ prompt: 'eval.persona', persona: { goal: 'learn' } }),
            },
          },
          then: [],
          judge: promptJudge({ prompt: 'eval.judge', criteria: { criterion: 'brief' } }),
        },
      ],
    });
    const [result] = await runChatEvaluation(evaluation, ctxWith(ai), {
      sessionId: SESSION,
      audience: 'user',
      locale: 'en',
      stores: { sessionStore: createInMemoryChatSessionStore() },
    });
    expect(result?.transcript?.map((t) => t.userMessage)).toEqual([
      'I am confused <script>',
      'Thanks',
    ]);
    expect(personaInputs[0]).toMatchObject({ goal: 'learn', turnIndex: 0, transcript: '[]' });
    // The transcript reaches the persona as delimiter-safe JSON.
    expect(String(personaInputs[1]?.transcript)).not.toContain('<script>');
    expect(JSON.parse(String(personaInputs[1]?.transcript))).toEqual([
      { user: 'I am confused <script>', assistant: 'Answer one.' },
    ]);
    expect(judgeInputs[0]).toMatchObject({ criterion: 'brief', turn: '' });
    expect(result?.failures).toEqual(['conversation judge failed: too long']);
  });

  it('a judge output without a boolean pass is a failure (conservative default)', async () => {
    const judge = promptJudge({ prompt: 'eval.judge' });
    const ai: AIService = {
      ...mockAI({}),
      generateWithUsage: (async () => ({
        finishReason: 'stop',
        data: { verdict: 'probably fine' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'm',
        provider: 'p',
        cost: 0,
      })) as unknown as AIService['generateWithUsage'],
    };
    expect(await judge({ ctx: ctxWith(ai), transcript: [] })).toEqual({ pass: false });
  });
});

describe('checkAssertion', () => {
  const completed = {
    type: 'turn.completed',
    turnId: 't',
    usage: { tokensIn: 0, tokensOut: 0 },
    cost: 0,
    inScope: false,
    refusalReason: 'off_topic',
    clientActions: [{ a: 1 }],
  };
  it('keeps the original lenient semantics for the original assertions', () => {
    expect(checkAssertion({ type: 'expectInScope', value: true }, [completed])).toBe(true);
    expect(checkAssertion({ type: 'expectRefusalReason', value: 'x' }, [])).toBe(true);
    expect(checkAssertion({ type: 'expectGuardFired', name: 'x' }, [])).toBe(true);
  });
  it('checks the exact assertions', () => {
    expect(checkAssertion({ type: 'expectCompletedInScope', value: false }, [completed])).toBe(
      true,
    );
    expect(checkAssertion({ type: 'expectCompletedInScope', value: true }, [completed])).toBe(
      false,
    );
    expect(
      checkAssertion({ type: 'expectCompletedRefusalReason', value: 'off_topic' }, [completed]),
    ).toBe(true);
    expect(checkAssertion({ type: 'expectClientActions', count: 1 }, [completed])).toBe(true);
    expect(
      checkAssertion({ type: 'expectReplyReplaced', code: 'app.x' }, [
        { type: 'message.replaced', text: '', code: 'app.x' },
      ]),
    ).toBe(true);
    expect(
      checkAssertion({ type: 'expectTurnFailed', code: 'c' }, [
        { type: 'turn.failed', code: 'd', message: '' },
      ]),
    ).toBe(false);
  });
});

describe('defineChatEvaluation — validation', () => {
  it('rejects a simulate block without a user function', () => {
    expect(() =>
      defineChatEvaluation({
        name: 'bad',
        chat,
        scenarios: [
          {
            name: 's',
            given: {},
            when: { simulate: { maxTurns: 2 } } as never,
            then: [],
          },
        ],
      }),
    ).toThrow(/defineChatEvaluation/);
  });
});
