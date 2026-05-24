import type { ChatEvaluationDefinition, ChatAssertion } from '../define/defineChatEvaluation.js';
import type { TraceRecorder } from './trace.js';
import { runChatTurn } from '../runtime/run-turn.js';
import type { ExecutionContext } from '@plumbus/core';

export interface EvalVerdict {
  scenario: string;
  passed: boolean;
  failures: string[];
}

export async function runChatEvaluation(
  evaluation: ChatEvaluationDefinition,
  ctx: ExecutionContext,
  opts: { sessionId: string; audience: string; locale: string; trace?: TraceRecorder },
): Promise<EvalVerdict[]> {
  const results: EvalVerdict[] = [];

  for (const scenario of evaluation.scenarios) {
    const failures: string[] = [];
    const events: unknown[] = [];
    for await (const evt of runChatTurn(ctx, {
      chatDefinition: evaluation.chat,
      sessionId: opts.sessionId,
      userMessage: scenario.when.send,
      audience: opts.audience,
      locale: opts.locale,
      traceRecorder: opts.trace,
    })) {
      events.push(evt);
      opts.trace?.recordEvent(evt);
    }

    for (const assertion of scenario.then) {
      if (!checkAssertion(assertion, events)) {
        failures.push(`Assertion failed: ${JSON.stringify(assertion)}`);
      }
    }

    results.push({ scenario: scenario.name, passed: failures.length === 0, failures });
  }

  return results;
}

function checkAssertion(assertion: ChatAssertion, events: unknown[]): boolean {
  if (assertion.type === 'expectNoticeEmitted') {
    return events.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'notice' &&
        (e as { code?: string }).code === assertion.code,
    );
  }
  if (assertion.type === 'expectInScope') {
    return events.some((e) => (e as { type?: string }).type === 'turn.completed');
  }
  return true;
}
