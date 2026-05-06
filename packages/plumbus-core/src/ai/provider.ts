// ── AI Provider Adapter Interface ──
// Abstract interface for AI provider adapters (OpenAI, Anthropic, etc.)

import type { AIProviderConfig } from '../types/config.js';
import { AIIncompleteOutputError, AIRefusalError } from './refusal.js';

// ── Provider Request ──
export interface ProviderRequest {
  /** System prompt / instructions */
  system?: string;
  /** User prompt content */
  prompt: string;
  /** Model name override */
  model?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens for response */
  maxTokens?: number;
  /** Response format hint */
  responseFormat?: 'text' | 'json';
  /** Provider-compatible JSON Schema for strict structured outputs. */
  responseSchema?: Record<string, unknown>;
  /** Transport used for provider-side structured outputs. Defaults to response_format. */
  structuredOutputTransport?: 'response_format' | 'tool';
  /** Request timeout in milliseconds (default: 600_000) */
  timeout?: number;
  /**
   * External AbortSignal (e.g. `ctx.signal`). When fired, the in-flight
   * fetch(es) for this request abort immediately. Combined with the internal
   * timeout signal via `AbortSignal.any([...])`, so whichever triggers first
   * wins.
   */
  signal?: AbortSignal;
  /**
   * Deterministic sampling seed. OpenAI-compatible providers (including xAI
   * Grok) honor this parameter: identical `{seed, temperature, model, prompt}`
   * tuples produce the same tokens. Combined with `temperature: 0`, lets
   * callers pin reproducible output for structural-planning prompts. Ignored
   * by providers that do not support it.
   */
  seed?: number;
}

/** Compose a request's optional user signal with a timeout, returning a single AbortSignal. */
export function combineRequestSignals(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeoutSignal;
  return AbortSignal.any([userSignal, timeoutSignal]);
}

// ── Provider Response ──
export interface ProviderResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  finishReason: string;
}

// ── Token Usage ──
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens served from provider cache (charged at reduced rate). */
  cachedInputTokens?: number;
  /** Tokens written to provider cache (charged at elevated rate — Anthropic only). */
  cacheWriteTokens?: number;
}

// ── Streaming ──
export interface ProviderStreamEvent {
  type: 'content_delta' | 'usage' | 'done' | 'error';
  /** Incremental text chunk (for content_delta) */
  delta?: string;
  /** Token usage (for usage / done events) */
  usage?: TokenUsage;
  /** Finish reason (for done events) */
  finishReason?: string;
  /** Error message (for error events) */
  error?: string;
}

// ── Embedding Request ──
export interface EmbeddingRequest {
  texts: string[];
  model?: string;
}

// ── Embedding Response ──
export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: { totalTokens: number };
}

// ── AI Provider Adapter ──
export interface AIProviderAdapter {
  readonly name: string;

  /** Send a completion request */
  complete(request: ProviderRequest): Promise<ProviderResponse>;

  /** Stream a completion request, yielding incremental events */
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;

  /** Generate embeddings for texts */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export class ProviderAPIError extends Error {
  readonly providerName: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(args: {
    providerName: string;
    message: string;
    retryable: boolean;
    attempts: number;
    statusCode?: number;
  }) {
    super(args.message);
    this.name = 'ProviderAPIError';
    this.providerName = args.providerName;
    this.statusCode = args.statusCode;
    this.retryable = args.retryable;
    this.attempts = args.attempts;
  }
}

export function isProviderAPIError(value: unknown): value is ProviderAPIError {
  if (value instanceof ProviderAPIError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.name === 'ProviderAPIError' &&
    typeof candidate.message === 'string' &&
    typeof candidate.providerName === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.attempts === 'number'
  );
}

const retryableStatusCodes = new Set([408, 429, 500, 502, 503, 504]);
const maxProviderAttempts = 3;
const baseRetryDelayMs = 750;
const maxRetryDelayMs = 5_000;

function isRetryableStatusCode(statusCode: number): boolean {
  return retryableStatusCodes.has(statusCode);
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) return undefined;

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(retryAt - Date.now(), 0);
}

function computeRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs != null) {
    return Math.min(Math.max(retryAfterMs, 0), maxRetryDelayMs);
  }
  return Math.min(baseRetryDelayMs * 2 ** (attempt - 1), maxRetryDelayMs);
}

function buildOpenAIResponseFormat(request: ProviderRequest): Record<string, unknown> | undefined {
  if (request.responseFormat !== 'json') return undefined;
  if (!request.responseSchema) return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      strict: true,
      schema: request.responseSchema,
    },
  };
}

const OPENAI_STRUCTURED_OUTPUT_TOOL_NAME = 'return_structured_response';

function shouldUseOpenAIStructuredTool(args: { request: ProviderRequest }): boolean {
  return (
    args.request.structuredOutputTransport === 'tool' &&
    args.request.responseFormat === 'json' &&
    !!args.request.responseSchema
  );
}

function buildOpenAIStructuredOutputTool(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: OPENAI_STRUCTURED_OUTPUT_TOOL_NAME,
      description: 'Return the complete structured response for this request.',
      strict: true,
      parameters: schema,
    },
  };
}

function extractOpenAIMessageContent(message: {
  content: string | null;
  tool_calls?: Array<{
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}): string {
  const structuredToolCall = message.tool_calls?.find(
    (toolCall) => toolCall.function?.name === OPENAI_STRUCTURED_OUTPUT_TOOL_NAME,
  );
  const toolArguments = structuredToolCall?.function?.arguments;
  if (typeof toolArguments === 'string' && toolArguments.length > 0) {
    return toolArguments;
  }

  return message.content ?? '';
}

function summarizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return { type: 'string', length: value.length, empty: value.length === 0 };
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeUnknown(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        summarizeUnknown(item),
      ]),
    );
  }
  return value;
}

function logEmptyOpenAIStructuredContent(args: {
  data: unknown;
  choice: {
    message: {
      content: string | null;
      refusal?: string | null;
      tool_calls?: Array<{
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string;
  };
  request: ProviderRequest;
  model: string;
}): void {
  const messageKeys = Object.keys(args.choice.message);
  const toolCallSummary =
    args.choice.message.tool_calls?.map((toolCall) => ({
      type: toolCall.type ?? null,
      name: toolCall.function?.name ?? null,
      argumentsChars: toolCall.function?.arguments?.length ?? 0,
    })) ?? [];

  // #region agent log
  fetch('http://127.0.0.1:7653/ingest/06cbeac8-a197-4896-9d68-c9e1a3d84ddc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '787c16',
    },
    body: JSON.stringify({
      sessionId: '787c16',
      runId: 'structured-output-empty',
      hypothesisId: 'H1,H2,H3,H4',
      location: 'packages/plumbus-core/src/ai/provider.ts:empty-structured-content',
      message: 'OpenAI-compatible structured output returned empty adapter content',
      data: {
        provider: 'openai',
        model: args.model,
        responseFormat: args.request.responseFormat ?? null,
        hasResponseSchema: !!args.request.responseSchema,
        structuredOutputTransport: args.request.structuredOutputTransport ?? null,
        finishReason: args.choice.finish_reason,
        messageKeys,
        contentType:
          args.choice.message.content === null ? 'null' : typeof args.choice.message.content,
        contentLength: args.choice.message.content?.length ?? 0,
        refusalLength: args.choice.message.refusal?.length ?? 0,
        toolCalls: toolCallSummary,
        responseShape: summarizeUnknown(args.data),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function buildEmptyOpenAIStructuredContentError(args: {
  data: unknown;
  choice: {
    message: {
      content: string | null;
      refusal?: string | null;
      tool_calls?: Array<{
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string;
  };
}): Error {
  const messageKeys = Object.keys(args.choice.message).join(',');
  const toolCallSummary =
    args.choice.message.tool_calls
      ?.map((toolCall) => {
        const name = toolCall.function?.name ?? 'unknown';
        const argumentLength = toolCall.function?.arguments?.length ?? 0;
        return `${name}:argumentsChars=${argumentLength}`;
      })
      .join('|') ?? 'none';

  return new Error(
    `OpenAI-compatible provider returned empty JSON response content ` +
      `finish_reason=${args.choice.finish_reason} messageKeys=${messageKeys || 'none'} ` +
      `hasRefusal=${args.choice.message.refusal ? 'true' : 'false'} ` +
      `toolCalls=${toolCallSummary} debugSession=787c16`,
  );
}

function openAIUsageToTokenUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function shouldUseOpenAIMaxCompletionTokens(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return /^(?:o\d|o\d-|o\d\.)/.test(normalizedModel) || normalizedModel.startsWith('gpt-5');
}

function applyOpenAITokenLimit(
  body: Record<string, unknown>,
  model: string,
  maxTokens?: number,
): void {
  if (!maxTokens) return;
  if (shouldUseOpenAIMaxCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
    return;
  }
  body.max_tokens = maxTokens;
}

function anthropicUsageToTokenUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildProviderErrorMessage(
  label: string,
  statusCode: number,
  body: string,
  attempts: number,
): string {
  const suffix = attempts > 1 ? ` after ${attempts} attempts` : '';
  const detail = body || 'Request failed';
  return `${label} error (${statusCode})${suffix}: ${detail}`;
}

async function executeRequestWithRetry(args: {
  providerName: string;
  errorLabel: string;
  send: () => Promise<Response>;
}): Promise<Response> {
  for (let attempt = 1; attempt <= maxProviderAttempts; attempt++) {
    const response = await args.send();
    if (response.ok) {
      return response;
    }

    const body = await response.text();
    const retryable = isRetryableStatusCode(response.status);
    if (!retryable || attempt === maxProviderAttempts) {
      throw new ProviderAPIError({
        providerName: args.providerName,
        statusCode: response.status,
        retryable,
        attempts: attempt,
        message: buildProviderErrorMessage(args.errorLabel, response.status, body, attempt),
      });
    }

    await waitForRetry(computeRetryDelayMs(attempt, response.headers.get('retry-after')));
  }

  throw new ProviderAPIError({
    providerName: args.providerName,
    retryable: false,
    attempts: maxProviderAttempts,
    message: `${args.errorLabel} request failed`,
  });
}

// ── OpenAI Adapter ──
export interface OpenAIAdapterConfig {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 600_000) */
  requestTimeout?: number;
}

export function createOpenAIAdapter(config: OpenAIAdapterConfig): AIProviderAdapter {
  const defaultModel = config.model ?? 'gpt-4o';
  const defaultEmbeddingModel = config.embeddingModel ?? 'text-embedding-3-small';
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const defaultTimeout = config.requestTimeout ?? 600_000;

  return {
    name: 'openai',

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const model = request.model ?? defaultModel;
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system) {
        messages.push({ role: 'system', content: request.system });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: request.temperature ?? 0.7,
      };
      applyOpenAITokenLimit(body, model, request.maxTokens);
      const structuredToolSchema = shouldUseOpenAIStructuredTool({ request })
        ? request.responseSchema
        : undefined;
      if (structuredToolSchema) {
        body.tools = [buildOpenAIStructuredOutputTool(structuredToolSchema)];
        body.tool_choice = {
          type: 'function',
          function: { name: OPENAI_STRUCTURED_OUTPUT_TOOL_NAME },
        };
      } else {
        const responseFormat = buildOpenAIResponseFormat(request);
        if (responseFormat) {
          body.response_format = responseFormat;
        }
      }
      if (typeof request.seed === 'number') {
        body.seed = request.seed;
      }

      const resp = await executeRequestWithRetry({
        providerName: 'openai',
        errorLabel: 'OpenAI API',
        send: () =>
          fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: combineRequestSignals(request.signal, request.timeout ?? defaultTimeout),
          }),
      });

      const data = (await resp.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            refusal?: string | null;
            tool_calls?: Array<{
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason: string;
        }>;
        model: string;
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      const choice = data.choices[0];
      if (!choice) throw new Error('OpenAI returned no choices');
      const usage = openAIUsageToTokenUsage(data.usage);
      const content = extractOpenAIMessageContent(choice.message);
      if (choice.message.refusal) {
        throw new AIRefusalError({
          provider: 'openai',
          model: data.model,
          refusalText: choice.message.refusal,
          usage,
        });
      }
      if (choice.finish_reason === 'length') {
        throw new AIIncompleteOutputError({
          provider: 'openai',
          model: data.model,
          partialText: content,
          usage,
          finishReason: choice.finish_reason,
        });
      }
      if (request.responseFormat === 'json' && content.trim().length === 0) {
        logEmptyOpenAIStructuredContent({ data, choice, request, model: data.model });
        throw buildEmptyOpenAIStructuredContentError({ data, choice });
      }
      return {
        content,
        model: data.model,
        usage,
        finishReason: choice.finish_reason,
      };
    },

    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      const model = request.model ?? defaultModel;
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system) {
        messages.push({ role: 'system', content: request.system });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: request.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
      };
      applyOpenAITokenLimit(body, model, request.maxTokens);
      const responseFormat = buildOpenAIResponseFormat(request);
      if (responseFormat) {
        body.response_format = responseFormat;
      }
      if (typeof request.seed === 'number') {
        body.seed = request.seed;
      }

      let resp: Response;
      try {
        resp = await executeRequestWithRetry({
          providerName: 'openai',
          errorLabel: 'OpenAI API',
          send: () =>
            fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: combineRequestSignals(request.signal, request.timeout ?? defaultTimeout),
            }),
        });
      } catch (error) {
        yield {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
        return;
      }

      yield* parseSSEStream(resp, parseOpenAISSEChunk);
    },

    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const body = {
        model: request.model ?? defaultEmbeddingModel,
        input: request.texts,
      };

      const resp = await executeRequestWithRetry({
        providerName: 'openai',
        errorLabel: 'OpenAI Embedding API',
        send: () =>
          fetch(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(defaultTimeout),
          }),
      });

      const data = (await resp.json()) as {
        data: Array<{ embedding: number[] }>;
        model: string;
        usage: { total_tokens: number };
      };

      return {
        embeddings: data.data.map((d) => d.embedding),
        model: data.model,
        usage: { totalTokens: data.usage.total_tokens },
      };
    },
  };
}

// ── Anthropic Adapter ──
export interface AnthropicAdapterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 600_000) */
  requestTimeout?: number;
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): AIProviderAdapter {
  const defaultModel = config.model ?? 'claude-sonnet-4-20250514';
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
  const defaultTimeout = config.requestTimeout ?? 600_000;

  return {
    name: 'anthropic',

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const body: Record<string, unknown> = {
        model: request.model ?? defaultModel,
        messages: [{ role: 'user', content: request.prompt }],
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      };
      if (request.system) body.system = request.system;
      if (request.responseFormat === 'json' && request.responseSchema) {
        body.output_config = {
          format: {
            type: 'json_schema',
            schema: request.responseSchema,
          },
        };
      }

      const resp = await executeRequestWithRetry({
        providerName: 'anthropic',
        errorLabel: 'Anthropic API',
        send: () =>
          fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: combineRequestSignals(request.signal, request.timeout ?? defaultTimeout),
          }),
      });

      const data = (await resp.json()) as {
        content: Array<{ type: string; text: string }>;
        model: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        stop_reason: string;
      };

      const usage = anthropicUsageToTokenUsage(data.usage);
      const text = data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');

      if (data.stop_reason === 'refusal') {
        throw new AIRefusalError({
          provider: 'anthropic',
          model: data.model,
          refusalText: text || 'Request refused by Anthropic',
          usage,
        });
      }
      if (data.stop_reason === 'max_tokens') {
        throw new AIIncompleteOutputError({
          provider: 'anthropic',
          model: data.model,
          partialText: text,
          usage,
          finishReason: data.stop_reason,
        });
      }

      return {
        content: text,
        model: data.model,
        usage,
        finishReason: data.stop_reason,
      };
    },

    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      const body: Record<string, unknown> = {
        model: request.model ?? defaultModel,
        messages: [{ role: 'user', content: request.prompt }],
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        stream: true,
      };
      if (request.system) body.system = request.system;
      if (request.responseFormat === 'json' && request.responseSchema) {
        body.output_config = {
          format: {
            type: 'json_schema',
            schema: request.responseSchema,
          },
        };
      }

      let resp: Response;
      try {
        resp = await executeRequestWithRetry({
          providerName: 'anthropic',
          errorLabel: 'Anthropic API',
          send: () =>
            fetch(`${baseUrl}/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify(body),
              signal: combineRequestSignals(request.signal, request.timeout ?? defaultTimeout),
            }),
        });
      } catch (error) {
        yield {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
        return;
      }

      yield* parseSSEStream(resp, parseAnthropicSSEChunk);
    },

    async embed(): Promise<EmbeddingResponse> {
      // Anthropic doesn't have a public embedding API
      // Users should pair with an embedding-capable provider for RAG
      throw new Error(
        'Anthropic does not provide an embedding API. Use an OpenAI-compatible provider for embeddings.',
      );
    },
  };
}

// ── Shared SSE Stream Parser ──

type SSEChunkParser = (eventType: string, data: string) => ProviderStreamEvent | null;

async function* parseSSEStream(
  resp: Response,
  parseChunk: SSEChunkParser,
): AsyncIterable<ProviderStreamEvent> {
  if (!resp.body) {
    yield { type: 'error', error: 'No response body for streaming' };
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }

          const event = parseChunk(currentEvent, data);
          if (event) yield event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOpenAISSEChunk(_eventType: string, data: string): ProviderStreamEvent | null {
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    // Usage-only chunk (sent when stream_options.include_usage is true)
    if (
      parsed.usage &&
      (!parsed.choices || parsed.choices.length === 0 || !parsed.choices[0]?.delta?.content)
    ) {
      return {
        type: 'usage',
        usage: {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
          cachedInputTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };
    }

    const choice = parsed.choices?.[0];
    if (!choice) return null;

    if (choice.finish_reason) {
      return { type: 'done', finishReason: choice.finish_reason };
    }

    if (choice.delta?.content) {
      return { type: 'content_delta', delta: choice.delta.content };
    }

    return null;
  } catch {
    return null;
  }
}

function parseAnthropicSSEChunk(eventType: string, data: string): ProviderStreamEvent | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;

    switch (eventType) {
      case 'content_block_delta': {
        const delta = parsed.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          return { type: 'content_delta', delta: delta.text };
        }
        return null;
      }
      case 'message_delta': {
        const delta = parsed.delta as { stop_reason?: string } | undefined;
        const usage = parsed.usage as { output_tokens?: number } | undefined;
        return {
          type: 'done',
          finishReason: delta?.stop_reason ?? 'end_turn',
          usage:
            usage?.output_tokens != null
              ? {
                  inputTokens: 0,
                  outputTokens: usage.output_tokens,
                  totalTokens: usage.output_tokens,
                }
              : undefined,
        };
      }
      case 'message_start': {
        const message = parsed.message as
          | { usage?: { input_tokens: number; output_tokens: number } }
          | undefined;
        if (message?.usage) {
          return {
            type: 'usage',
            usage: {
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              totalTokens: message.usage.input_tokens + message.usage.output_tokens,
            },
          };
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Provider Factory ──

/** Create a provider adapter by name from a provider config entry */
export function createProviderAdapter(
  name: string,
  providerConfig: AIProviderConfig,
): AIProviderAdapter {
  const cfg = {
    apiKey: providerConfig.apiKey,
    model: providerConfig.model,
    baseUrl: providerConfig.baseUrl,
    requestTimeout: providerConfig.requestTimeout,
  };

  switch (name) {
    case 'openai':
      return createOpenAIAdapter(cfg);
    case 'anthropic':
      return createAnthropicAdapter(cfg);
    default:
      // Unknown providers: try OpenAI-compat adapter (covers Ollama, Azure, etc.)
      return createOpenAIAdapter(cfg);
  }
}
