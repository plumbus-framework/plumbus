import type { z } from 'zod';
import type { EventDefinition } from '../types/event.js';

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in value &&
    'safeParse' in value &&
    typeof (value as Record<string, unknown>).safeParse === 'function'
  );
}

interface DefineEventInput<TPayload extends z.ZodTypeAny> {
  name: string;
  description?: string;
  domain?: string;
  version?: string;
  tags?: string[];

  payload: TPayload;
}

export function defineEvent<TPayload extends z.ZodTypeAny>(
  config: DefineEventInput<TPayload>,
): EventDefinition<TPayload> {
  if (!config.name) {
    throw new Error('Event name is required');
  }
  if (!isZodSchema(config.payload)) {
    throw new Error(`Event "${config.name}": payload must be a Zod schema`);
  }

  return Object.freeze({ ...config });
}
