// ── AI Provider Adapter Interface ──
// Abstract interface for AI provider adapters (OpenAI, Anthropic, etc.)

import type { AIProviderConfig } from '../types/config.js';
import { allKnownModels, calculateModelCost, type Kind } from './model-pricing.js';
import { AIIncompleteOutputError, AIInvalidRequestError, AIRefusalError } from './refusal.js';

// ── Provider Request ──

// ── Tool-calling protocol (provider-native caller tools) ──

export interface AITool {
  name: string;
  description: string;
  /** JSON Schema object root (from zodToProviderJsonSchema(...).schema). */
  parameters: Record<string, unknown>;
}

export type AIToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };

/** Discriminated on argumentsStatus. Adapters parse at the boundary (§6.4). */
export type AIToolCall =
  | {
      id: string;
      name: string;
      argumentsStatus: 'parsed';
      arguments: unknown;
    }
  | {
      id: string;
      name: string;
      argumentsStatus: 'invalid';
      /** Internal transcript data — MUST NOT reach browser events, audit, or user errors. Bounded. */
      rawArguments: string;
      /** Internal transcript data — MUST NOT reach browser events, audit, or user errors. Bounded. */
      parseError: string;
    };

export interface AIToolExecutionOptions {
  /** Chat tool rounds MUST set this false (§6.2). */
  parallelToolCalls?: boolean;
}

export interface AIProviderCapabilities {
  tools: boolean;
  streamingTools: boolean;
  parallelToolCalls: boolean;
  parallelToolCallControl: boolean;
  namedToolChoice: boolean;
}

/**
 * A single chat-history turn. Used for native multi-turn requests where the
 * model should see real conversation flow. Optional — when omitted, providers
 * fall back to single-user-message mode built from `ProviderRequest.prompt`.
 * The user/assistant variants remain construction-compatible with existing
 * callers; the `tool` variant carries a tool observation back to the model.
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AIToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export interface ProviderRequest {
  /** System prompt / instructions */
  system?: string;
  /**
   * User prompt content. Used as the SOLE user message when `messages` is
   * absent. When `messages` is provided, this field is IGNORED — the messages
   * array is the conversation. Callers passing `messages` may still set
   * `prompt: ''` for type-compat.
   */
  prompt: string;
  /**
   * Optional native multi-turn conversation history. When present, providers
   * send `[system?, ...messages]` to the API instead of `[system?, {role:'user', content: prompt}]`.
   * The LAST entry should be a `user` message (the latest turn). Order is
   * preserved exactly as supplied. Empty array is treated as "no messages"
   * (falls back to single-user mode using `prompt`).
   */
  messages?: ChatMessage[];
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
  /** Request timeout in milliseconds (default: 120_000) */
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
  /** Provider-native caller tools. When present the adapter forwards them and returns tool calls. */
  tools?: AITool[];
  /** Tool-choice directive forwarded to the provider. */
  toolChoice?: AIToolChoice;
  /** Tool-execution options (e.g. disable parallel tool calls). */
  toolExecution?: AIToolExecutionOptions;
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
  /** Parsed provider tool calls (present when finishReason is 'tool_calls'/'tool_use'). */
  toolCalls?: AIToolCall[];
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
  /** Provider tool calls on a done event (streaming tools; unused by built-in adapters this release). */
  toolCalls?: AIToolCall[];
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
  /**
   * USD cost computed from the pricing catalog using `usage.totalTokens` against
   * the model's input rate (embeddings are input-only). `0` for unknown models
   * — same convention as completion-side cost. Optional so that external
   * `AIProviderAdapter` implementations written before this field existed still
   * satisfy the interface; consumers reading `cost` should treat `undefined` as
   * "unknown" (typically by coalescing to `0`).
   */
  cost?: number;
}

// ── Model Listing ──

/**
 * A single model entry returned by `AIProviderAdapter.listModels()`.
 * The id is whatever the provider's `/v1/models` returns; pricing and `kind`
 * are joined from the framework's pricing catalog. Models not in the catalog
 * surface as `kind: 'unknown'` with `null` prices.
 */
export interface ProviderModel {
  /** API identifier (the value to pass as `model` in requests). */
  id: string;
  /** Adapter name (e.g. "openai", "anthropic", or a custom adapter's name). */
  provider: string;
  /** Capability classification, from the pricing catalog. `'unknown'` if not in the catalog. */
  kind: Kind | 'unknown';
  /** USD per 1M input tokens, or `null` if the model is not in the catalog. */
  inputPerMTok: number | null;
  /** USD per 1M output tokens, or `null` if the model is not in the catalog. */
  outputPerMTok: number | null;
  /** Provider-supplied human-readable label (Anthropic exposes this; OpenAI doesn't). */
  displayName?: string;
  /** ISO-8601 creation timestamp when the provider exposes one. */
  createdAt?: string;
  /** Owner/team (OpenAI exposes this; Anthropic doesn't). */
  ownedBy?: string;
}

/**
 * Optional filter passed to `AIProviderAdapter.listModels()`. `kind` accepts a
 * single Kind or an array. When unset, all models are returned (including
 * unknown ones). When set against an official endpoint, unknown-kind models
 * are excluded; against a custom endpoint they are included alongside the
 * filtered matches (see adapter docs).
 */
export interface ListModelsFilter {
  kind?: Kind | Kind[];
}

// ── AI Provider Adapter ──
export interface AIProviderAdapter {
  readonly name: string;

  /**
   * Declared provider capabilities. Optional for backward compat with external
   * adapters: an adapter that omits this MUST be treated by callers as
   * declaring every value `false` (§6.2). Both built-in adapters declare it and
   * implement caller tools natively (C11).
   */
  readonly capabilities?: AIProviderCapabilities;

  /** Send a completion request */
  complete(request: ProviderRequest): Promise<ProviderResponse>;

  /** Stream a completion request, yielding incremental events */
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;

  /** Generate embeddings for texts */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /**
   * List models the provider exposes for this account, joined against the
   * framework's pricing catalog. Optional — custom adapters that don't
   * implement it still satisfy the interface.
   *
   * Filtering rule (see docs for full details):
   * - No filter → all models, including unknown-kind entries.
   * - Filter + official endpoint → only matching kinds; unknowns excluded.
   * - Filter + custom endpoint → matching kinds **plus** all unknowns.
   *
   * On network error / 404 / unsupported endpoint, returns `[]` and emits
   * one `console.warn`; does not throw.
   */
  listModels?(filter?: ListModelsFilter): Promise<ProviderModel[]>;
}

/**
 * Shared logic used by adapter `listModels` implementations: join a list of
 * provider-supplied model entries against the pricing catalog, then apply
 * the kind filter respecting the official-endpoint rule.
 */
export function joinAndFilterModels(args: {
  provider: string;
  entries: Array<{
    id: string;
    displayName?: string;
    createdAt?: string;
    ownedBy?: string;
  }>;
  filter: ListModelsFilter | undefined;
  isOfficial: boolean;
}): ProviderModel[] {
  const catalog = new Map<string, { kind: Kind; inputPerMTok: number; outputPerMTok: number }>(
    allKnownModels()
      .filter(([, rate]) => rate.kind != null)
      .map(([id, rate]) => [
        id,
        {
          kind: rate.kind as Kind,
          inputPerMTok: rate.inputPerMTok,
          outputPerMTok: rate.outputPerMTok,
        },
      ]),
  );

  const joined: ProviderModel[] = args.entries.map((e) => {
    const cat = catalog.get(e.id);
    const model: ProviderModel = {
      id: e.id,
      provider: args.provider,
      kind: cat?.kind ?? 'unknown',
      inputPerMTok: cat?.inputPerMTok ?? null,
      outputPerMTok: cat?.outputPerMTok ?? null,
    };
    if (e.displayName != null) model.displayName = e.displayName;
    if (e.createdAt != null) model.createdAt = e.createdAt;
    if (e.ownedBy != null) model.ownedBy = e.ownedBy;
    return model;
  });

  if (!args.filter?.kind) return joined;

  const allowedKinds = new Set<Kind>(
    Array.isArray(args.filter.kind) ? args.filter.kind : [args.filter.kind],
  );

  return joined.filter((m) => {
    if (m.kind === 'unknown') return !args.isOfficial;
    return allowedKinds.has(m.kind);
  });
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
      `toolCalls=${toolCallSummary}`,
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

/**
 * `gpt-5.5+` only accept the API default temperature (1). Sending any other
 * value (including Plumbus's 0.7 default) returns HTTP 400 `unsupported_value`.
 *
 * Do not broaden this to all `gpt-5*` models — earlier lines such as
 * `gpt-5.4` / `gpt-5.4-mini` still support custom temperature. Token-limit
 * mapping (`max_completion_tokens`) remains a separate, wider check.
 */
function shouldOmitOpenAITemperature(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return /^gpt-5\.(?:[5-9]|\d{2,})(?:$|[-.])/.test(normalizedModel);
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

function applyOpenAITemperature(
  body: Record<string, unknown>,
  model: string,
  temperature?: number,
): void {
  if (shouldOmitOpenAITemperature(model)) return;
  body.temperature = temperature ?? 0.7;
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

// ── Provider tool-calling helpers ──

/** Portable tool-name grammar (C9). The reserved `flow__` prefix is enforced at chat bind time, not here. */
const CALLER_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Validate caller-supplied tool definitions: portable name grammar + uniqueness. */
function validateCallerTools(tools: AITool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!CALLER_TOOL_NAME_PATTERN.test(tool.name)) {
      throw new AIInvalidRequestError({
        reason: 'tool_name_invalid',
        message: `Tool name "${tool.name}" does not match ^[A-Za-z][A-Za-z0-9_-]{0,63}$`,
      });
    }
    if (seen.has(tool.name)) {
      throw new AIInvalidRequestError({
        reason: 'duplicate_tool_name',
        message: `Duplicate tool name "${tool.name}"`,
      });
    }
    seen.add(tool.name);
  }
}

/** Normalize a provider-specific finish/stop reason into the framework's vocabulary. */
export function normalizeFinishReason(
  raw: string | undefined,
): 'stop' | 'length' | 'refusal' | 'tool_calls' | 'other' {
  switch (raw) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Guard used by both adapters: caller tools cannot coexist with the tool-transport structured output (§6.6). */
function assertNoStructuredOutputToolConflict(request: ProviderRequest): void {
  if (request.structuredOutputTransport === 'tool') {
    throw new AIInvalidRequestError({
      reason: 'caller_tools_conflict_with_structured_output_tool',
      message: "Caller tools cannot be combined with structuredOutputTransport: 'tool'.",
    });
  }
}

/** Map framework ChatMessage[] to OpenAI chat-completions messages. */
function toOpenAIMessages(request: ProviderRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  if (request.messages && request.messages.length > 0) {
    for (const msg of request.messages) {
      if (msg.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
      } else if (msg.role === 'assistant') {
        const entry: Record<string, unknown> = {
          role: 'assistant',
          content: msg.content.length > 0 ? msg.content : null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments:
                tc.argumentsStatus === 'parsed'
                  ? JSON.stringify(tc.arguments ?? {})
                  : tc.rawArguments,
            },
          }));
        }
        messages.push(entry);
      } else {
        messages.push({ role: 'user', content: msg.content });
      }
    }
  } else {
    messages.push({ role: 'user', content: request.prompt });
  }
  return messages;
}

/** Map AIToolChoice to the OpenAI `tool_choice` wire value. */
function buildOpenAIToolChoice(toolChoice: AIToolChoice | undefined): unknown {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
  return { type: 'function', function: { name: toolChoice.function.name } };
}

/** Parse OpenAI tool_calls into framework AIToolCall records (§6.4). */
function parseOpenAIToolCalls(
  toolCalls:
    | Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    | undefined,
): AIToolCall[] {
  if (!toolCalls) return [];
  const result: AIToolCall[] = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name) continue;
    const id = tc.id ?? crypto.randomUUID();
    const rawArguments = tc.function?.arguments ?? '';
    try {
      const parsed = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
      result.push({ id, name, argumentsStatus: 'parsed', arguments: parsed });
    } catch (err) {
      result.push({
        id,
        name,
        argumentsStatus: 'invalid',
        rawArguments: rawArguments.slice(0, 4096),
        parseError: (err instanceof Error ? err.message : String(err)).slice(0, 512),
      });
    }
  }
  return result;
}

/** Map framework ChatMessage[] to Anthropic messages (tool_use / tool_result blocks). */
function toAnthropicMessages(request: ProviderRequest): Record<string, unknown>[] {
  if (!request.messages || request.messages.length === 0) {
    return [{ role: 'user', content: request.prompt }];
  }
  const out: Record<string, unknown>[] = [];
  for (const msg of request.messages) {
    if (msg.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (msg.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (msg.content.length > 0) blocks.push({ type: 'text', text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.argumentsStatus === 'parsed' ? (tc.arguments ?? {}) : {},
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : msg.content });
    } else {
      out.push({ role: 'user', content: msg.content });
    }
  }
  return out;
}

/** Map AIToolChoice + execution options to the Anthropic `tool_choice` wire value. */
function buildAnthropicToolChoice(
  toolChoice: AIToolChoice | undefined,
  toolExecution: AIToolExecutionOptions | undefined,
): Record<string, unknown> | undefined {
  const disableParallel = toolExecution?.parallelToolCalls === false;
  if (toolChoice === undefined && !disableParallel) return undefined;
  let base: Record<string, unknown>;
  if (toolChoice === undefined || toolChoice === 'auto') base = { type: 'auto' };
  else if (toolChoice === 'none') base = { type: 'none' };
  else base = { type: 'tool', name: toolChoice.function.name };
  if (disableParallel && base.type !== 'none') base.disable_parallel_tool_use = true;
  return base;
}

/** Parse Anthropic tool_use content blocks into framework AIToolCall records. */
function parseAnthropicToolUse(
  content: Array<{ type: string; id?: string; name?: string; input?: unknown }>,
): AIToolCall[] {
  return content
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      name: c.name ?? '',
      argumentsStatus: 'parsed' as const,
      arguments: c.input ?? {},
    }));
}

// ── OpenAI Adapter ──
export interface OpenAIAdapterConfig {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 120_000) */
  requestTimeout?: number;
}

export function createOpenAIAdapter(config: OpenAIAdapterConfig): AIProviderAdapter {
  const defaultModel = config.model ?? 'gpt-4o';
  const defaultEmbeddingModel = config.embeddingModel ?? 'text-embedding-3-small';
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const defaultTimeout = config.requestTimeout ?? 120_000;

  return {
    name: 'openai',
    capabilities: {
      tools: true,
      streamingTools: false,
      parallelToolCalls: true,
      parallelToolCallControl: true,
      namedToolChoice: true,
    },

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const model = request.model ?? defaultModel;
      const messages = toOpenAIMessages(request);

      const body: Record<string, unknown> = {
        model,
        messages,
      };
      applyOpenAITemperature(body, model, request.temperature);
      applyOpenAITokenLimit(body, model, request.maxTokens);
      if (request.tools && request.tools.length > 0) {
        assertNoStructuredOutputToolConflict(request);
        validateCallerTools(request.tools);
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        const callerToolChoice = buildOpenAIToolChoice(request.toolChoice);
        if (callerToolChoice !== undefined) body.tool_choice = callerToolChoice;
        if (request.toolExecution?.parallelToolCalls === false) {
          body.parallel_tool_calls = false;
        }
      } else {
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
              id?: string;
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
      if (request.tools && request.tools.length > 0 && choice.finish_reason === 'tool_calls') {
        return {
          content,
          model: data.model,
          usage,
          finishReason: 'tool_calls',
          toolCalls: parseOpenAIToolCalls(choice.message.tool_calls),
        };
      }
      // Only treat `finish_reason === 'length'` as a hard failure when the
      // caller asked for structured JSON output. For free-text generation,
      // a `length` finish is a partial-success: return what we have rather
      // than discarding tokens the caller already paid for.
      if (
        choice.finish_reason === 'length' &&
        (request.responseFormat === 'json' || !!request.responseSchema)
      ) {
        throw new AIIncompleteOutputError({
          provider: 'openai',
          model: data.model,
          partialText: content,
          usage,
          finishReason: choice.finish_reason,
        });
      }
      if (request.responseFormat === 'json' && content.trim().length === 0) {
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
      // Multi-turn path: when `messages` is supplied, append them verbatim.
      // Single-turn path (legacy): single user message from `prompt`.
      if (request.messages && request.messages.length > 0) {
        for (const msg of request.messages) {
          messages.push({ role: msg.role, content: msg.content });
        }
      } else {
        messages.push({ role: 'user', content: request.prompt });
      }

      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      applyOpenAITemperature(body, model, request.temperature);
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

      const totalTokens = data.usage.total_tokens;
      return {
        embeddings: data.data.map((d) => d.embedding),
        model: data.model,
        usage: { totalTokens },
        cost: calculateModelCost(totalTokens, 0, data.model),
      };
    },

    async listModels(filter?: ListModelsFilter): Promise<ProviderModel[]> {
      const isOfficial = baseUrl === 'https://api.openai.com/v1';
      try {
        const resp = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(defaultTimeout),
        });
        if (!resp.ok) {
          console.warn(
            `[plumbus] OpenAI listModels: ${baseUrl}/models returned ${resp.status} ${resp.statusText}; returning empty list`,
          );
          return [];
        }
        const data = (await resp.json()) as {
          data?: Array<{ id: string; created?: number; owned_by?: string }>;
        };
        if (!Array.isArray(data.data)) {
          console.warn(
            `[plumbus] OpenAI listModels: ${baseUrl}/models returned unexpected response shape; returning empty list`,
          );
          return [];
        }
        const entries = data.data.map((m) => {
          const e: { id: string; createdAt?: string; ownedBy?: string } = { id: m.id };
          if (typeof m.created === 'number') {
            e.createdAt = new Date(m.created * 1000).toISOString();
          }
          if (typeof m.owned_by === 'string') {
            e.ownedBy = m.owned_by;
          }
          return e;
        });
        return joinAndFilterModels({ provider: 'openai', entries, filter, isOfficial });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[plumbus] OpenAI listModels: ${baseUrl}/models failed (${msg}); returning empty list`,
        );
        return [];
      }
    },
  };
}

// ── Anthropic Adapter ──
export interface AnthropicAdapterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 120_000) */
  requestTimeout?: number;
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): AIProviderAdapter {
  const defaultModel = config.model ?? 'claude-sonnet-4-20250514';
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
  const defaultTimeout = config.requestTimeout ?? 120_000;

  return {
    name: 'anthropic',
    capabilities: {
      tools: true,
      streamingTools: false,
      parallelToolCalls: true,
      parallelToolCallControl: true,
      namedToolChoice: true,
    },

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const messages = toAnthropicMessages(request);
      const body: Record<string, unknown> = {
        model: request.model ?? defaultModel,
        messages,
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
      if (request.tools && request.tools.length > 0) {
        assertNoStructuredOutputToolConflict(request);
        validateCallerTools(request.tools);
        body.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
        const callerToolChoice = buildAnthropicToolChoice(
          request.toolChoice,
          request.toolExecution,
        );
        if (callerToolChoice !== undefined) body.tool_choice = callerToolChoice;
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
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
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
        .map((c) => c.text ?? '')
        .join('');

      if (data.stop_reason === 'refusal') {
        throw new AIRefusalError({
          provider: 'anthropic',
          model: data.model,
          refusalText: text || 'Request refused by Anthropic',
          usage,
        });
      }
      if (request.tools && request.tools.length > 0 && data.stop_reason === 'tool_use') {
        return {
          content: text,
          model: data.model,
          usage,
          finishReason: 'tool_use',
          toolCalls: parseAnthropicToolUse(data.content),
        };
      }
      // Mirror the OpenAI adapter: only throw on max_tokens when the caller
      // requested structured JSON output. Free-text completions should return
      // the partial content.
      if (
        data.stop_reason === 'max_tokens' &&
        (request.responseFormat === 'json' || !!request.responseSchema)
      ) {
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
      // Multi-turn path: when `messages` is supplied, send them verbatim.
      // Single-turn path: synthesize a single user message from `prompt`.
      const messages =
        request.messages && request.messages.length > 0
          ? request.messages.map((m) => ({ role: m.role, content: m.content }))
          : [{ role: 'user', content: request.prompt }];
      const body: Record<string, unknown> = {
        model: request.model ?? defaultModel,
        messages,
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

    async listModels(filter?: ListModelsFilter): Promise<ProviderModel[]> {
      const isOfficial = baseUrl === 'https://api.anthropic.com/v1';
      const entries: Array<{ id: string; displayName?: string; createdAt?: string }> = [];
      let afterId: string | undefined;
      try {
        // Anthropic /models is paginated via `has_more` / `last_id` + `after_id` query param.
        // Cap iterations defensively so a misbehaving API doesn't loop forever.
        for (let page = 0; page < 20; page++) {
          const url = new URL(`${baseUrl}/models`);
          url.searchParams.set('limit', '100');
          if (afterId) url.searchParams.set('after_id', afterId);
          const resp = await fetch(url, {
            method: 'GET',
            headers: {
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(defaultTimeout),
          });
          if (!resp.ok) {
            console.warn(
              `[plumbus] Anthropic listModels: ${url} returned ${resp.status} ${resp.statusText}; returning ${entries.length === 0 ? 'empty' : 'partial'} list`,
            );
            if (entries.length === 0) return [];
            break;
          }
          const data = (await resp.json()) as {
            data?: Array<{ id: string; display_name?: string; created_at?: string }>;
            has_more?: boolean;
            last_id?: string | null;
          };
          if (!Array.isArray(data.data)) {
            console.warn(
              `[plumbus] Anthropic listModels: ${url} returned unexpected response shape; returning ${entries.length === 0 ? 'empty' : 'partial'} list`,
            );
            if (entries.length === 0) return [];
            break;
          }
          for (const m of data.data) {
            const e: { id: string; displayName?: string; createdAt?: string } = { id: m.id };
            if (typeof m.display_name === 'string') e.displayName = m.display_name;
            if (typeof m.created_at === 'string') e.createdAt = m.created_at;
            entries.push(e);
          }
          if (!data.has_more || !data.last_id) break;
          afterId = data.last_id;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[plumbus] Anthropic listModels: ${baseUrl}/models failed (${msg}); returning ${entries.length === 0 ? 'empty' : 'partial'} list`,
        );
        if (entries.length === 0) return [];
      }
      return joinAndFilterModels({ provider: 'anthropic', entries, filter, isOfficial });
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
      throw new Error(
        `Unsupported AI provider "${name}". Only "openai" and "anthropic" are supported.`,
      );
  }
}
