import type { z } from 'zod';
import type { ModelConfig, PromptDefinition } from '../types/prompt.js';
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

interface DefinePromptInput<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  name: string;
  system?: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  input: TInput;
  output: TOutput;
  model?: ModelConfig;

  /** See `PromptDefinition.skipStreamValidationFallback`. */
  skipStreamValidationFallback?: boolean;

  /** See `PromptDefinition.disableTextModeBrevityHint`. */
  disableTextModeBrevityHint?: boolean;

  /** See `PromptDefinition.appendUnsubstitutedInput`. */
  appendUnsubstitutedInput?: boolean;

  /** See `PromptDefinition.disableStrictStructuredOutputs`. */
  disableStrictStructuredOutputs?: boolean;

  /** See `PromptDefinition.requireStrictStructuredOutputs`. */
  requireStrictStructuredOutputs?: boolean;

  /** See `PromptDefinition.structuredOutputTransport`. */
  structuredOutputTransport?: 'response_format' | 'tool';
}

export function definePrompt<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  config: DefinePromptInput<TInput, TOutput>,
): PromptDefinition<TInput, TOutput> {
  if (!config.name) {
    throwDefineValidationError('Prompt name is required', { field: 'name' });
  }
  if (!isZodSchema(config.input)) {
    throwDefineValidationError(`Prompt "${config.name}": input must be a Zod schema`, {
      field: 'input',
    });
  }
  if (!isZodSchema(config.output)) {
    throwDefineValidationError(`Prompt "${config.name}": output must be a Zod schema`, {
      field: 'output',
    });
  }
  if (config.disableStrictStructuredOutputs && config.requireStrictStructuredOutputs) {
    throwDefineValidationError(
      `Prompt "${config.name}": cannot both disable and require strict structured outputs`,
      { field: 'structuredOutputs' },
    );
  }

  return deepFreeze({ ...config });
}
