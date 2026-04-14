// ── Output Validation with Retry ──
// Validates AI responses against Zod schemas, retries on mismatch

import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
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

function stripMarkdownCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function extractJsonCandidate(content: string): string {
  const stripped = stripMarkdownCodeFence(content);

  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    return stripped;
  }

  const firstObjectStart = stripped.indexOf('{');
  const lastObjectEnd = stripped.lastIndexOf('}');
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    return stripped.slice(firstObjectStart, lastObjectEnd + 1);
  }

  const firstArrayStart = stripped.indexOf('[');
  const lastArrayEnd = stripped.lastIndexOf(']');
  if (firstArrayStart >= 0 && lastArrayEnd > firstArrayStart) {
    return stripped.slice(firstArrayStart, lastArrayEnd + 1);
  }

  return stripped;
}

function escapeControlCharactersInsideStrings(content: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (const character of content) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }

    if (character === '"') {
      result += character;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (character === '\n') {
        result += '\\n';
        continue;
      }
      if (character === '\r') {
        result += '\\r';
        continue;
      }
      if (character === '\t') {
        result += '\\t';
        continue;
      }
    }

    result += character;
  }

  return result;
}

function parseJsonCandidate(candidate: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(candidate, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const firstError = errors[0];
    if (firstError) {
      throw new SyntaxError(
        `JSONC parse failed with code ${firstError.error} at offset ${firstError.offset}`,
      );
    }

    throw new SyntaxError('JSONC parse failed');
  }

  return parsed;
}

function parseStructuredResponse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (originalError) {
    let lastError =
      originalError instanceof Error ? originalError : new Error(String(originalError));
    const extracted = extractJsonCandidate(content);

    if (extracted !== content) {
      try {
        return JSON.parse(extracted);
      } catch (extractedError) {
        lastError =
          extractedError instanceof Error ? extractedError : new Error(String(extractedError));
      }
    }

    const sanitized = escapeControlCharactersInsideStrings(extracted);
    if (sanitized !== extracted) {
      try {
        return JSON.parse(sanitized);
      } catch (sanitizedError) {
        lastError =
          sanitizedError instanceof Error ? sanitizedError : new Error(String(sanitizedError));
      }
    }

    const completeJsonLikeObject =
      (sanitized.startsWith('{') && sanitized.includes('}')) ||
      (sanitized.startsWith('[') && sanitized.includes(']'));

    if (completeJsonLikeObject) {
      try {
        return parseJsonCandidate(sanitized);
      } catch (jsoncError) {
        lastError = jsoncError instanceof Error ? jsoncError : new Error(String(jsoncError));
      }
    }

    throw lastError;
  }
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
      const parsed = parseStructuredResponse(response.content);
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
