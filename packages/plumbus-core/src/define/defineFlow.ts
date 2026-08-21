import type { z } from 'zod';
import type {
  FlowBudget,
  FlowDefinition,
  FlowRetryPolicy,
  FlowSchedule,
  FlowStep,
  FlowTrigger,
} from '../types/flow.js';
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

interface DefineFlowInput<TInput extends z.ZodTypeAny, TState extends z.ZodTypeAny> {
  name: string;
  domain: string;
  description?: string;
  tags?: string[];

  input: TInput;
  state?: TState;
  steps: FlowStep[];

  trigger?: FlowTrigger;
  schedule?: FlowSchedule;
  retry?: FlowRetryPolicy;
  version?: string;
  budget?: FlowBudget;
}

export function defineFlow<TInput extends z.ZodTypeAny, TState extends z.ZodTypeAny = z.ZodTypeAny>(
  config: DefineFlowInput<TInput, TState>,
): FlowDefinition<TInput, TState> {
  if (!config.name) {
    throwDefineValidationError('Flow name is required', { field: 'name' });
  }
  if (!config.domain) {
    throwDefineValidationError('Flow domain is required', { field: 'domain' });
  }
  if (!isZodSchema(config.input)) {
    throwDefineValidationError(`Flow "${config.name}": input must be a Zod schema`, {
      field: 'input',
    });
  }
  if (!Array.isArray(config.steps) || config.steps.length === 0) {
    throwDefineValidationError(`Flow "${config.name}": at least one step is required`, {
      field: 'steps',
    });
  }

  return deepFreeze({ ...config });
}
