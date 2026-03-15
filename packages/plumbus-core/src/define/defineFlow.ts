import type { z } from 'zod';
import type {
  FlowDefinition,
  FlowRetryPolicy,
  FlowSchedule,
  FlowStep,
  FlowTrigger,
} from '../types/flow.js';

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
}

export function defineFlow<TInput extends z.ZodTypeAny, TState extends z.ZodTypeAny = z.ZodTypeAny>(
  config: DefineFlowInput<TInput, TState>,
): FlowDefinition<TInput, TState> {
  if (!config.name) {
    throw new Error('Flow name is required');
  }
  if (!config.domain) {
    throw new Error('Flow domain is required');
  }
  if (!isZodSchema(config.input)) {
    throw new Error(`Flow "${config.name}": input must be a Zod schema`);
  }
  if (!Array.isArray(config.steps) || config.steps.length === 0) {
    throw new Error(`Flow "${config.name}": at least one step is required`);
  }

  return Object.freeze({ ...config });
}
