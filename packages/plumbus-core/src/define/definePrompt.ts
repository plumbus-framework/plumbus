import type { z } from 'zod';
import type { ModelConfig, PromptDefinition } from '../types/prompt.js';

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
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  input: TInput;
  output: TOutput;
  model?: ModelConfig;
}

export function definePrompt<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  config: DefinePromptInput<TInput, TOutput>,
): PromptDefinition<TInput, TOutput> {
  if (!config.name) {
    throw new Error('Prompt name is required');
  }
  if (!isZodSchema(config.input)) {
    throw new Error(`Prompt "${config.name}": input must be a Zod schema`);
  }
  if (!isZodSchema(config.output)) {
    throw new Error(`Prompt "${config.name}": output must be a Zod schema`);
  }

  return Object.freeze({ ...config });
}
