// ── Output Validation with Retry ──
// Validates AI responses against Zod schemas, retries on mismatch

import type { z } from 'zod';
import type {
  AIProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from './provider.js';

export interface ValidationRetryConfig {
  /** Max retries on validation failure (default 2) */
  maxRetries?: number;
  /** Whether to append validation error to retry prompt */
  feedbackOnError?: boolean;
}

export interface ValidatedResponse<T> {
  data: T;
  raw: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export async function generateWithValidation<T>(
  provider: AIProviderAdapter,
  request: ProviderRequest,
  schema: z.ZodType<T>,
  config?: ValidationRetryConfig,
): Promise<ValidatedResponse<T>> {
  const maxRetries = config?.maxRetries ?? 2;
  const feedbackOnError = config?.feedbackOnError ?? true;

  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastError: Error | null = null;
  let currentPrompt = request.prompt;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // OpenAI requires the word "json" in the prompt when using json_object response format.
    // Auto-inject a JSON instruction if the prompt doesn't already mention it.
    let promptForRequest = currentPrompt;
    if (!currentPrompt.toLowerCase().includes('json')) {
      promptForRequest = `${currentPrompt}\n\nRespond with a valid JSON object.`;
    }

    const response: ProviderResponse = await provider.complete({
      ...request,
      prompt: promptForRequest,
      responseFormat: 'json',
    });

    totalUsage = {
      inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
      outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
      totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
      cachedInputTokens:
        (totalUsage.cachedInputTokens ?? 0) + (response.usage.cachedInputTokens ?? 0),
      cacheWriteTokens: (totalUsage.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0),
    };

    try {
      const parsed = JSON.parse(response.content);
      const result = schema.parse(parsed);
      return {
        data: result,
        raw: response.content,
        attempts: attempt,
        usage: totalUsage,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt <= maxRetries && feedbackOnError) {
        currentPrompt = `${request.prompt}\n\nYour previous response was invalid. Error: ${lastError.message}\nPlease fix the output to match the required schema.`;
      }
    }
  }

  throw new Error(
    `AI output validation failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
  );
}
