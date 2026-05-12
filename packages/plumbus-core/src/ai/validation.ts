// ── Output Validation with Retry ──
// Validates AI responses against Zod schemas, retries on mismatch

import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';
import type { AIValidationOptions } from '../types/context.js';
import type {
  AIProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from './provider.js';
import { AIIncompleteOutputError } from './refusal.js';

export interface ValidationRetryConfig extends AIValidationOptions {}

export interface ValidatedResponse<T> {
  data: T;
  raw: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export class AIValidationError extends Error {
  readonly attempts: number;
  readonly rawOutput: string | null;
  readonly validationMessage: string | null;
  /**
   * Accumulated token usage across all retry attempts the provider actually
   * ran before this error was thrown. Present when the caller threaded
   * provider metadata through `generateWithValidation`; otherwise a zero
   * record (kept non-optional so failure-path cost recording does not need
   * null-checks).
   */
  readonly usage: TokenUsage;
  /** Resolved model name when the error was thrown (empty string if unknown). */
  readonly model: string;
  /** Resolved provider name when the error was thrown (empty string if unknown). */
  readonly provider: string;

  constructor(input: {
    attempts: number;
    rawOutput: string | null;
    lastError: Error | null;
    usage?: TokenUsage;
    model?: string;
    provider?: string;
  }) {
    super(
      `AI output validation failed after ${input.attempts} attempts: ${input.lastError?.message}`,
    );
    this.name = 'AIValidationError';
    this.attempts = input.attempts;
    this.rawOutput = input.rawOutput;
    this.validationMessage = input.lastError?.message ?? null;
    this.usage = input.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.model = input.model ?? '';
    this.provider = input.provider ?? '';
  }
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

/**
 * Detects whether an output schema accepts a raw string at the top level.
 *
 * When the prompt author declares `output: z.string()` (or a trivially
 * wrapped variant like `z.string().optional()` / `.nullable()`), the intent
 * is to let the AI return raw text — typically a custom line-delimited
 * format parsed by the capability. In that case we MUST NOT force the
 * provider into JSON mode (OpenAI `response_format: json_object`), because
 * the model will wrap the text into a JSON object and downstream
 * `schema.parse(<object>)` will blow up with "Expected string, received
 * object".
 *
 * Unwrapping `.optional()` / `.nullable()` is safe: they still pass a raw
 * string through unchanged.
 */
function isStringOutputSchema(schema: z.ZodType<unknown>): boolean {
  let current: z.ZodTypeAny = schema as z.ZodTypeAny;

  // Unwrap one level of optional/nullable/default at a time, capping the
  // loop so a bad schema can never hang the process.
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodString) {
      return true;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    return false;
  }

  return false;
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
  config?: ValidationRetryConfig & {
    /**
     * Optional resolved model + provider metadata attached to any
     * `AIValidationError` thrown from this call. Used by the AI service
     * failure-path cost recorder so it can bill the sunk spend against the
     * right model. Omitted = error is thrown with empty strings (still
     * compiles and still carries `usage`).
     */
    model?: string;
    provider?: string;
  },
): Promise<ValidatedResponse<T>> {
  const maxRetries = config?.maxRetries ?? 2;
  const feedbackOnError = config?.feedbackOnError ?? true;
  // Prompts with `output: z.string()` want raw text (e.g. a pipe-separated
  // line format parsed by the capability). Forcing JSON mode on those
  // would make the model wrap the text in a JSON object and shatter
  // schema validation, so we switch to text mode and skip JSON parsing.
  const textOutput = isStringOutputSchema(schema);

  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastError: Error | null = null;
  let lastRawOutput: string | null = null;
  let currentPrompt = request.prompt;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    let promptForRequest = currentPrompt;
    if (!textOutput && !request.responseSchema && !currentPrompt.toLowerCase().includes('json')) {
      // OpenAI requires the word "json" in the prompt when using
      // json_object response format. Only inject the hint for JSON-mode
      // prompts without a provider schema — text-mode prompts never go into
      // json_object, and json_schema requests should not need a prose JSON
      // instruction as a substitute for constrained decoding.
      promptForRequest = `${currentPrompt}\n\nRespond with a valid JSON object.`;
    }

    const response: ProviderResponse = await provider.complete({
      ...request,
      prompt: promptForRequest,
      responseFormat: textOutput ? 'text' : 'json',
    });
    lastRawOutput = response.content;

    if (
      !textOutput &&
      (response.finishReason === 'length' || response.finishReason === 'max_tokens')
    ) {
      throw new AIIncompleteOutputError({
        provider: config?.provider ?? provider.name,
        model: config?.model ?? response.model,
        partialText: response.content,
        usage: response.usage,
        finishReason: response.finishReason,
      });
    }

    totalUsage = {
      inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
      outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
      totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
      cachedInputTokens:
        (totalUsage.cachedInputTokens ?? 0) + (response.usage.cachedInputTokens ?? 0),
      cacheWriteTokens: (totalUsage.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0),
    };

    try {
      const parsed = textOutput ? response.content : parseStructuredResponse(response.content);
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

  throw new AIValidationError({
    attempts: maxRetries + 1,
    rawOutput: lastRawOutput,
    lastError,
    usage: totalUsage,
    model: config?.model ?? '',
    provider: config?.provider ?? provider.name,
  });
}
