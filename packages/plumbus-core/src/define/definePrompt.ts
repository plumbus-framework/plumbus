import { z } from 'zod';
import type { ModelConfig, PromptDefinition } from '../types/prompt.js';

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
  if (!(config.input instanceof z.ZodType)) {
    throw new Error(`Prompt "${config.name}": input must be a Zod schema`);
  }
  if (!(config.output instanceof z.ZodType)) {
    throw new Error(`Prompt "${config.name}": output must be a Zod schema`);
  }

  return Object.freeze({ ...config });
}
