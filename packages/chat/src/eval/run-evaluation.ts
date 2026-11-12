import type { ExecutionContext } from '@plumbus/core';
import type {
  ChatAssertion,
  ChatEvalJudgeVerdict,
  ChatEvalTurnRecord,
  ChatEvaluationDefinition,
  ChatEvaluationScenario,
  ChatScriptedTurn,
  ChatTurnJudge,
} from '../define/defineChatEvaluation.js';
import { runChatTurn, type RunChatTurnOpts } from '../runtime/run-turn.js';
import type { ChatEvent } from '../types/event.js';
import type { TraceRecorder } from './trace.js';

export interface EvalVerdict {
  scenario: string;
  passed: boolean;
  failures: string[];
  /** Every turn the scenario ran, in order (one for a `send` scenario). */
  transcript?: ChatEvalTurnRecord[];
}

/** Server-owned inputs for one evaluated turn (what `prepareTurn` gives the HTTP route). */
export interface ChatEvalTurnInputs {
  promptInput?: Record<string, unknown>;
  trustedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface RunChatEvaluationOpts {
  sessionId: string;
  audience: string;
  locale: string;
  trace?: TraceRecorder;
  /** Evaluate against injected storage (and `validateReply`, etc.) instead of `ctx.data`. */
  stores?: RunChatTurnOpts;
  /**
   * Session id per scenario, so multi-turn scenarios do not share history.
   * Default: `sessionId` for every scenario (the original behavior).
   */
  sessionIdFor?: (scenario: ChatEvaluationScenario) => string | Promise<string>;
  /** Per-turn server-owned inputs, e.g. the prompt input the app builds for a turn. */
  turnInputs?: (args: {
    scenario: ChatEvaluationScenario;
    turnIndex: number;
    transcript: ChatEvalTurnRecord[];
  }) => ChatEvalTurnInputs | Promise<ChatEvalTurnInputs>;
}

function recordTurn(index: number, userMessage: string, events: ChatEvent[]): ChatEvalTurnRecord {
  let reply = '';
  const record: ChatEvalTurnRecord = {
    index,
    userMessage,
    reply: '',
    events,
    completed: false,
    clientActions: [],
  };
  for (const evt of events) {
    if (evt.type === 'message.delta') reply += evt.text;
    else if (evt.type === 'message.replaced') reply = evt.text;
    else if (evt.type === 'turn.completed') {
      record.completed = true;
      record.inScope = evt.inScope;
      record.refusalReason = evt.refusalReason ?? null;
      record.clientActions = evt.clientActions ?? [];
      if (evt.moderation) record.moderationCode = evt.moderation.code;
    } else if (evt.type === 'turn.failed') record.failureCode = evt.code;
  }
  record.reply = reply;
  return record;
}

async function judge(
  name: string,
  run: () => ChatEvalJudgeVerdict | Promise<ChatEvalJudgeVerdict>,
): Promise<string | null> {
  try {
    const verdict = await run();
    if (verdict?.pass === true) return null;
    return `${name} failed${verdict?.reason ? `: ${verdict.reason}` : ''}`;
  } catch (err) {
    return `${name} threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run each scenario through the real turn pipeline (`runChatTurn`) and check
 * its assertions and judges. A `send` scenario is one turn; `turns` runs a
 * scripted conversation; `simulate` lets a simulated user write each next turn.
 * Conversations run on one session, so server-persisted chats see their own
 * history; client-persisted chats get it as `clientHistory`.
 */
export async function runChatEvaluation(
  evaluation: ChatEvaluationDefinition,
  ctx: ExecutionContext,
  opts: RunChatEvaluationOpts,
): Promise<EvalVerdict[]> {
  const results: EvalVerdict[] = [];
  const clientHistoryMode = evaluation.chat.persistence?.messageContent === 'client';

  for (const scenario of evaluation.scenarios) {
    const failures: string[] = [];
    const transcript: ChatEvalTurnRecord[] = [];
    const sessionId = opts.sessionIdFor ? await opts.sessionIdFor(scenario) : opts.sessionId;

    const runTurn = async (userMessage: string): Promise<ChatEvalTurnRecord> => {
      const turnIndex = transcript.length;
      const inputs = opts.turnInputs
        ? await opts.turnInputs({ scenario, turnIndex, transcript: [...transcript] })
        : {};
      const events: ChatEvent[] = [];
      for await (const evt of runChatTurn(
        ctx,
        {
          chatDefinition: evaluation.chat,
          sessionId,
          userMessage,
          audience: opts.audience,
          locale: opts.locale,
          traceRecorder: opts.trace,
          ...(clientHistoryMode
            ? {
                clientHistory: transcript.flatMap((t) => [
                  { role: 'user' as const, content: t.userMessage },
                  {
                    role: 'assistant' as const,
                    content: t.reply,
                    ...(t.refusalReason ? { refusalReason: t.refusalReason } : {}),
                  },
                ]),
              }
            : {}),
          ...(inputs.promptInput ? { promptInput: inputs.promptInput } : {}),
          ...(inputs.trustedHistory ? { trustedHistory: inputs.trustedHistory } : {}),
        },
        opts.stores,
      )) {
        events.push(evt);
      }
      const record = recordTurn(turnIndex, userMessage, events);
      transcript.push(record);
      return record;
    };

    const checkTurn = async (
      record: ChatEvalTurnRecord,
      assertions: ChatAssertion[] | undefined,
      turnJudge: ChatTurnJudge | undefined,
      label: string,
    ): Promise<void> => {
      for (const assertion of assertions ?? []) {
        if (!checkAssertion(assertion, record.events)) {
          failures.push(`${label}Assertion failed: ${JSON.stringify(assertion)}`);
        }
      }
      if (turnJudge) {
        const failure = await judge(`${label}judge`, () =>
          turnJudge({ ctx, turn: record, transcript: [...transcript] }),
        );
        if (failure) failures.push(failure);
      }
    };

    const multiTurn = !('send' in scenario.when);
    const perTurn = async (record: ChatEvalTurnRecord, scripted?: ChatScriptedTurn) => {
      const label = multiTurn ? `turn ${record.index + 1}: ` : '';
      await checkTurn(record, scenario.perTurn?.then, scenario.perTurn?.judge, label);
      if (scripted) await checkTurn(record, scripted.then, scripted.judge, label);
    };

    const when = scenario.when;
    if ('send' in when) {
      await perTurn(await runTurn(when.send));
    } else if ('turns' in when) {
      for (const scripted of when.turns) {
        await perTurn(await runTurn(scripted.send), scripted);
      }
    } else {
      const sim = when.simulate;
      for (let turnIndex = 0; turnIndex < sim.maxTurns; turnIndex++) {
        let message: string | null;
        if (turnIndex === 0 && sim.opening !== undefined) {
          message = sim.opening;
        } else {
          try {
            message = await sim.user({ ctx, transcript: [...transcript], turnIndex });
          } catch (err) {
            failures.push(
              `simulated user threw at turn ${turnIndex + 1}: ${err instanceof Error ? err.message : String(err)}`,
            );
            break;
          }
        }
        if (message === null || message.trim() === '') break;
        await perTurn(await runTurn(message));
      }
      if (transcript.length === 0) failures.push('simulated user produced no turn');
    }

    const last = transcript[transcript.length - 1];
    if (last) {
      for (const assertion of scenario.then) {
        if (!checkAssertion(assertion, last.events)) {
          failures.push(`Assertion failed: ${JSON.stringify(assertion)}`);
        }
      }
    }
    if (scenario.judge) {
      const conversationJudge = scenario.judge;
      const failure = await judge('conversation judge', () =>
        conversationJudge({ ctx, transcript: [...transcript] }),
      );
      if (failure) failures.push(failure);
    }

    results.push({ scenario: scenario.name, passed: failures.length === 0, failures, transcript });
  }

  return results;
}

function completedOf(
  events: unknown[],
): Extract<ChatEvent, { type: 'turn.completed' }> | undefined {
  return events.find(
    (e): e is Extract<ChatEvent, { type: 'turn.completed' }> =>
      (e as { type?: string }).type === 'turn.completed',
  );
}

export function checkAssertion(assertion: ChatAssertion, events: unknown[]): boolean {
  const ofType = (type: string) => events.filter((e) => (e as { type?: string }).type === type);
  switch (assertion.type) {
    case 'expectNoticeEmitted':
      return ofType('notice').some((e) => (e as { code?: string }).code === assertion.code);
    case 'expectInScope':
      // Original semantics: the turn completed. Use expectCompletedInScope for the value.
      return completedOf(events) !== undefined;
    case 'expectTurnCompleted':
      return completedOf(events) !== undefined;
    case 'expectTurnFailed':
      return ofType('turn.failed').some(
        (e) => assertion.code === undefined || (e as { code?: string }).code === assertion.code,
      );
    case 'expectCompletedInScope':
      return completedOf(events)?.inScope === assertion.value;
    case 'expectCompletedRefusalReason': {
      const completed = completedOf(events);
      return completed !== undefined && (completed.refusalReason ?? null) === assertion.value;
    }
    case 'expectReplyReplaced':
      return ofType('message.replaced').some(
        (e) => assertion.code === undefined || (e as { code?: string }).code === assertion.code,
      );
    case 'expectClientActions':
      return (completedOf(events)?.clientActions?.length ?? 0) === assertion.count;
    default:
      // expectRefusalReason / expectGuardFired: accepted, not checked (original semantics).
      return true;
  }
}
