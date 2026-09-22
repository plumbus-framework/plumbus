import type { z } from 'zod';
import {
  type DecisionQuestions,
  validateDecisionQuestions,
} from '../ai/decision.js';
import type { DecisionDefinition, DecisionModelConfig } from '../types/decision.js';
import { deepFreeze } from '../types/deep-freeze.js';
import { throwDefineValidationError } from './validation-error.js';

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in value &&
    'safeParse' in value &&
    typeof (value as Record<string, unknown>).safeParse === 'function'
  );
}

interface DefineDecisionInput<TQuestions extends DecisionQuestions> {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  /**
   * Optional Zod schema for the `state` this decision evaluates. When set,
   * `ctx.ai.decide({ decision })` parses the state before any network I/O, so
   * a contract drift fails locally instead of producing a confident answer
   * about the wrong shape.
   */
  state?: z.ZodTypeAny;

  /** The named questions. Answers come back under the same keys. */
  questions: TQuestions;

  model?: DecisionModelConfig;
}

/**
 * Define a reusable decision contract: a named set of typed questions plus
 * the optional shape of the state they are asked about.
 *
 * Structural limits (choice option count, score level count) are checked here
 * rather than at call time, so a malformed rubric fails at import.
 *
 * ```ts
 * export const triageTicket = defineDecision({
 *   name: 'support.triageTicket',
 *   state: z.object({ message: z.string() }),
 *   questions: {
 *     isUrgent: noul('Does this convey urgency?'),
 *     department: choice('Which team should handle this?', {
 *       billing: 'Payments, invoicing, refunds',
 *       technical: 'Bugs, outages, integrations',
 *     }),
 *   },
 * });
 * ```
 */
export function defineDecision<TQuestions extends DecisionQuestions>(
  config: DefineDecisionInput<TQuestions>,
): DecisionDefinition<TQuestions> {
  if (!config.name) {
    throwDefineValidationError('Decision name is required', { field: 'name' });
  }
  if (config.state !== undefined && !isZodSchema(config.state)) {
    throwDefineValidationError(`Decision "${config.name}": state must be a Zod schema`, {
      field: 'state',
    });
  }
  if (typeof config.questions !== 'object' || config.questions === null) {
    throwDefineValidationError(`Decision "${config.name}": questions must be an object`, {
      field: 'questions',
    });
  }

  try {
    validateDecisionQuestions(config.questions);
  } catch (err) {
    throwDefineValidationError(
      `Decision "${config.name}": ${err instanceof Error ? err.message : String(err)}`,
      { field: 'questions' },
    );
  }

  return deepFreeze({ ...config }) as DecisionDefinition<TQuestions>;
}
