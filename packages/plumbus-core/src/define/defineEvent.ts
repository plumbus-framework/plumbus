import type { z } from 'zod';
import type { EventDefinition } from '../types/event.js';
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
    throwDefineValidationError('Event name is required', { field: 'name' });
  }
  if (!isZodSchema(config.payload)) {
    throwDefineValidationError(`Event "${config.name}": payload must be a Zod schema`, {
      field: 'payload',
    });
  }

  return deepFreeze({ ...config });
}
