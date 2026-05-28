import { z } from '@plumbus/core/zod';
import { deepFreeze } from '../internal/deep-freeze.js';
import { throwDefineValidationError } from '../internal/validation-error.js';
import type { ChatDefinition } from '../types/chat.js';

export type ChatAssertion =
  | { type: 'expectInScope'; value: boolean }
  | { type: 'expectRefusalReason'; value: string }
  | { type: 'expectNoticeEmitted'; code: string }
  | { type: 'expectGuardFired'; name: string };

export interface ChatEvaluationScenario {
  name: string;
  given: Record<string, unknown>;
  when: { send: string };
  then: ChatAssertion[];
}

export interface ChatEvaluationDefinition {
  kind: 'chatEvaluation';
  name: string;
  chat: ChatDefinition;
  scenarios: ChatEvaluationScenario[];
}

const schema = z.object({
  name: z.string().min(1),
  chat: z.custom<ChatDefinition>(),
  scenarios: z.array(
    z.object({
      name: z.string(),
      given: z.record(z.unknown()),
      when: z.object({ send: z.string() }),
      then: z.array(z.record(z.unknown())),
    }),
  ),
});

export function defineChatEvaluation(config: {
  name: string;
  chat: ChatDefinition;
  scenarios: ChatEvaluationScenario[];
}): ChatEvaluationDefinition {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throwDefineValidationError(`defineChatEvaluation: ${detail}`);
  }
  return deepFreeze({ ...config, kind: 'chatEvaluation' as const });
}
