import type { z } from 'zod';

// ── Model Config ──
export interface ModelConfig {
  provider?: string;
  name?: string;
  temperature?: number;
  maxTokens?: number;
}

// ── Prompt Definition ──
export interface PromptDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  input: TInput;
  output: TOutput;
  model?: ModelConfig;
}
