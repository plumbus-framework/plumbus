import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ContentBlock,
  type Message,
  type OutputConfig,
  type SystemContentBlock,
  type Tool,
  type ToolConfiguration,
  type ToolChoice,
  type ToolResultContentBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  AIProviderAdapter,
  AITool,
  AIToolCall,
  AIToolChoice,
  ChatMessage,
  EmbeddingRequest,
  EmbeddingResponse,
  ListModelsFilter,
  ProviderModel,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  TokenUsage,
} from '@plumbus/core';
import { BEDROCK_DEFAULT_EMBEDDING_MODEL, type BedrockAdapterConfig } from './types.js';
import {
  createPricingStore,
  type BedrockPricingStore,
  normalizeBedrockModelId,
} from './pricing.js';

function combineAbort(
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  if (!userSignal) return timeoutSignal;
  return AbortSignal.any([userSignal, timeoutSignal]);
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function mapUsage(
  raw:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      }
    | undefined,
): TokenUsage {
  if (!raw) return emptyUsage();
  const inputTokens = raw.inputTokens ?? 0;
  const outputTokens = raw.outputTokens ?? 0;
  const cacheRead = raw.cacheReadInputTokens ?? 0;
  const cacheWrite = raw.cacheWriteInputTokens ?? 0;
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    // Bedrock reports cache tokens OUTSIDE `inputTokens`, so the fallback total
    // has to add them back in (AWS: total input = input + cacheRead + cacheWrite).
    totalTokens: raw.totalTokens ?? inputTokens + outputTokens + cacheRead + cacheWrite,
  };
  if (raw.cacheReadInputTokens != null && raw.cacheReadInputTokens > 0) {
    usage.cachedInputTokens = raw.cacheReadInputTokens;
  }
  if (raw.cacheWriteInputTokens != null && raw.cacheWriteInputTokens > 0) {
    usage.cacheWriteTokens = raw.cacheWriteInputTokens;
  }
  return usage;
}

function mapBedrockError(err: unknown): Error {
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'ValidationException' || name === 'AccessDeniedException') {
      return new Error(`Bedrock request failed (${name}): ${err.message}`);
    }
    return err;
  }
  return new Error(String(err));
}

/**
 * Map a Plumbus tool choice onto Converse. Returns `undefined` for `auto` /
 * unset so the field is omitted: `toolChoice` support is model-dependent on
 * Bedrock and sending an explicit `{ auto: {} }` makes models that only accept
 * `tools` reject the request, while omitting it is the same semantics.
 * `'none'` never reaches here — the caller omits `toolConfig` entirely.
 */
function toToolChoice(choice: AIToolChoice | undefined): ToolChoice | undefined {
  if (typeof choice === 'object' && choice?.type === 'function') {
    return { tool: { name: choice.function.name } };
  }
  return undefined;
}

function toBedrockTools(tools: AITool[]): Tool[] {
  return tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.parameters },
        },
      }) as Tool,
  );
}

/** Shared Converse / ConverseStream toolConfig. `toolChoice: 'none'` omits tools. */
function buildToolConfig(request: ProviderRequest): ToolConfiguration | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  if (request.toolChoice === 'none') return undefined;
  const config: ToolConfiguration = { tools: toBedrockTools(request.tools) };
  const toolChoice = toToolChoice(request.toolChoice);
  if (toolChoice) config.toolChoice = toolChoice;
  return config;
}

function parseToolUse(block: ToolUseBlock): AIToolCall {
  const id = block.toolUseId ?? `tool_${block.name ?? 'unknown'}`;
  const name = block.name ?? '';
  try {
    return {
      id,
      name,
      argumentsStatus: 'parsed',
      arguments: block.input ?? {},
    };
  } catch (err) {
    return {
      id,
      name,
      argumentsStatus: 'invalid',
      rawArguments: JSON.stringify(block.input ?? {}),
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

function assistantContentFromToolCalls(toolCalls: AIToolCall[]): ContentBlock[] {
  return toolCalls.map(
    (tc) =>
      ({
        toolUse: {
          toolUseId: tc.id,
          name: tc.name,
          input: tc.argumentsStatus === 'parsed' ? tc.arguments : {},
        },
      }) as ContentBlock,
  );
}

/** Converse rejects empty text blocks; a turn must carry something. */
const EMPTY_TEXT_PLACEHOLDER = '(no content)';

function toolResultBlock(msg: Extract<ChatMessage, { role: 'tool' }>): ContentBlock {
  const toolResult: ToolResultContentBlock = { text: msg.content || EMPTY_TEXT_PLACEHOLDER };
  return {
    toolResult: {
      toolUseId: msg.toolCallId,
      content: [toolResult],
    },
  } as ContentBlock;
}

function toBedrockMessages(request: ProviderRequest): Message[] {
  if (!request.messages || request.messages.length === 0) {
    return [{ role: 'user', content: [{ text: request.prompt || EMPTY_TEXT_PLACEHOLDER }] }];
  }

  const messages: Message[] = [];
  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];
    if (!msg) continue;

    if (msg.role === 'tool') {
      // Converse requires every toolResult for one assistant turn to arrive in a
      // SINGLE following user message (and roles to alternate), while the core
      // tool loop emits one `tool` message per call. Coalesce the whole run —
      // otherwise parallel tool calls produce consecutive user turns with
      // partial result sets, which Bedrock rejects.
      const content: ContentBlock[] = [];
      while (i < request.messages.length) {
        const next = request.messages[i];
        if (next?.role !== 'tool') break;
        content.push(toolResultBlock(next));
        i++;
      }
      i--; // step back onto the last consumed entry for the outer loop
      messages.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: [{ text: msg.content || EMPTY_TEXT_PLACEHOLDER }] });
      continue;
    }

    const content: ContentBlock[] = [];
    if (msg.content) content.push({ text: msg.content });
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      content.push(...assistantContentFromToolCalls(msg.toolCalls));
    }
    messages.push({
      role: 'assistant',
      content: content.length > 0 ? content : [{ text: EMPTY_TEXT_PLACEHOLDER }],
    });
  }
  return messages;
}

/**
 * Modeled ConverseStream failures. They arrive as union members on the event
 * stream (never thrown), so they must be inspected explicitly.
 */
function streamEventError(event: {
  internalServerException?: { message?: string };
  modelStreamErrorException?: { message?: string };
  validationException?: { message?: string };
  throttlingException?: { message?: string };
  serviceUnavailableException?: { message?: string };
}): string | null {
  const modeled = [
    ['InternalServerException', event.internalServerException],
    ['ModelStreamErrorException', event.modelStreamErrorException],
    ['ValidationException', event.validationException],
    ['ThrottlingException', event.throttlingException],
    ['ServiceUnavailableException', event.serviceUnavailableException],
  ] as const;
  for (const [name, ex] of modeled) {
    if (ex) {
      return `Bedrock request failed (${name}): ${ex.message ?? 'stream terminated by service'}`;
    }
  }
  return null;
}

/**
 * Converse `outputConfig.textFormat` for provider-side structured outputs.
 *
 * Opt-in (`structuredOutputs: 'native'`): support is model-dependent, and a
 * model that does not accept `outputConfig` fails the whole request, so the
 * default stays on core's validate-and-repair path. Returns undefined when the
 * caller did not ask for a schema.
 */
function buildOutputConfig(
  request: ProviderRequest,
  mode: 'off' | 'native',
): OutputConfig | undefined {
  if (mode !== 'native') return undefined;
  if (!request.responseSchema) return undefined;
  // The tool transport routes the schema through toolConfig instead; forwarding
  // both would double-constrain the response.
  if (request.structuredOutputTransport === 'tool') return undefined;
  return {
    textFormat: {
      type: 'json_schema',
      structure: {
        // Converse takes the schema as a JSON *string*, not an object.
        jsonSchema: { name: 'response', schema: JSON.stringify(request.responseSchema) },
      },
    },
  };
}

/**
 * InvokeModel embedding request body. Titan takes one text per call
 * (`inputText`); Cohere takes a batch plus an `input_type` discriminator.
 */
function embeddingBody(modelId: string, text: string, inputType: string): Record<string, unknown> {
  // Matches `cohere.…` and geo-prefixed `us.cohere.…`.
  if (/(^|\.)cohere\./i.test(modelId)) {
    return { texts: [text], input_type: inputType };
  }
  return { inputText: text };
}

/** Titan returns `embedding`; Cohere returns `embeddings` (one per input text). */
function parseEmbeddingResponse(body: unknown): { embedding: number[]; tokens: number } {
  const parsed = JSON.parse(new TextDecoder().decode(body as Uint8Array)) as {
    embedding?: number[];
    embeddings?: number[][] | { float?: number[][] };
    inputTextTokenCount?: number;
  };
  if (parsed.embedding) {
    return { embedding: parsed.embedding, tokens: parsed.inputTextTokenCount ?? 0 };
  }
  const cohere = Array.isArray(parsed.embeddings) ? parsed.embeddings : parsed.embeddings?.float;
  const first = cohere?.[0];
  if (first) {
    return { embedding: first, tokens: parsed.inputTextTokenCount ?? 0 };
  }
  throw new Error('Bedrock embedding response missing embedding vector');
}

function extractTextAndTools(content: ContentBlock[] | undefined): {
  text: string;
  toolCalls: AIToolCall[];
} {
  let text = '';
  const toolCalls: AIToolCall[] = [];
  for (const block of content ?? []) {
    if (block.text) text += block.text;
    if (block.toolUse) toolCalls.push(parseToolUse(block.toolUse));
  }
  return { text, toolCalls };
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    // Ran out of room, same class as max_tokens for callers.
    case 'model_context_window_exceeded':
      return 'length';
    // Core normalizes 'content_filter'/'refusal' to 'refusal'; the Converse
    // spellings would otherwise fall through to 'other' and look like an
    // unknown state rather than a blocked response.
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return reason ?? 'stop';
  }
}

function filterModels(
  entries: Array<{
    id: string;
    rate: { inputPerMTok: number; outputPerMTok: number; kind?: string };
  }>,
  filter: ListModelsFilter | undefined,
): ProviderModel[] {
  const joined: ProviderModel[] = entries.map((e) => ({
    id: e.id,
    provider: 'bedrock',
    kind: (e.rate.kind as ProviderModel['kind']) ?? 'unknown',
    inputPerMTok: e.rate.inputPerMTok,
    outputPerMTok: e.rate.outputPerMTok,
  }));
  if (!filter?.kind) return joined;
  const allowed = new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind]);
  return joined.filter((m) => m.kind !== 'unknown' && allowed.has(m.kind as never));
}

/**
 * Create an Amazon Bedrock {@link AIProviderAdapter}.
 *
 * Sync factory: pricing warms on first request (or immediately if you call
 * the returned adapter after awaiting a manual warm — see package docs).
 * When `pricingFilePath` is set, auto-download is skipped.
 */
export function createBedrockAdapter(config: BedrockAdapterConfig): AIProviderAdapter {
  const defaultModel = config.defaultModel ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';
  const defaultEmbeddingModel = config.defaultEmbeddingModel ?? BEDROCK_DEFAULT_EMBEDDING_MODEL;
  const defaultTimeout = config.requestTimeout ?? 120_000;
  const embedConcurrency = Math.max(1, config.embedConcurrency ?? 4);
  const inputType = config.embeddingInputType ?? 'search_document';
  const structuredOutputs = config.structuredOutputs ?? 'off';

  const client =
    config.runtimeClient ??
    new BedrockRuntimeClient({
      region: config.region,
      credentials: config.credentials,
      endpoint: config.endpoint,
    });

  const pricing: BedrockPricingStore =
    config.pricingStore ??
    createPricingStore({
      region: config.region,
      pricingFilePath: config.pricingFilePath,
      pricingCacheTtlMs: config.pricingCacheTtlMs,
      pricingRefreshTimeoutMs: config.pricingRefreshTimeoutMs,
    });

  const shouldWarmOnCreate = config.warmPricingOnCreate !== false && config.pricingStore == null;
  if (shouldWarmOnCreate) {
    // Kick off warm without blocking factory; methods await the same promise.
    void pricing.warm().catch((err) => {
      console.warn(
        `[plumbus/ai-bedrock] pricing warm failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async function ensurePricing(): Promise<void> {
    // Always warm before inference / listModels so file mode and auto-download
    // work even when warmPricingOnCreate is false (tests / smokes).
    try {
      await pricing.warm();
    } catch (err) {
      if (config.pricingFilePath) {
        throw err instanceof Error
          ? err
          : new Error(`Failed to load Bedrock pricing file: ${String(err)}`);
      }
      // Auto-download failures already warn inside the store.
    }
  }

  return {
    name: 'bedrock',
    capabilities: {
      tools: true,
      streamingTools: true,
      parallelToolCalls: true,
      parallelToolCallControl: false,
      namedToolChoice: true,
    },

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      await ensurePricing();
      const modelId = request.model ?? defaultModel;
      const messages = toBedrockMessages(request);
      const system: SystemContentBlock[] | undefined = request.system
        ? [{ text: request.system }]
        : undefined;

      const toolConfig: ToolConfiguration | undefined = buildToolConfig(request);

      const inferenceConfig: { maxTokens?: number; temperature?: number } = {};
      if (request.maxTokens != null) inferenceConfig.maxTokens = request.maxTokens;
      if (request.temperature != null) inferenceConfig.temperature = request.temperature;

      try {
        const out = await client.send(
          new ConverseCommand({
            modelId,
            messages,
            system,
            inferenceConfig: Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined,
            toolConfig,
            outputConfig: buildOutputConfig(request, structuredOutputs),
          }),
          {
            abortSignal: combineAbort(
              request.signal,
              AbortSignal.timeout(request.timeout ?? defaultTimeout),
            ),
          },
        );

        const { text, toolCalls } = extractTextAndTools(out.output?.message?.content);
        const usage = mapUsage(out.usage);
        const finishReason = mapStopReason(out.stopReason);
        const cost = pricing.calculateCost(modelId, usage);

        const response: ProviderResponse = {
          content: text,
          model: modelId,
          usage,
          finishReason,
        };
        // Left unset when no rate is known so core falls back instead of
        // recording unpriced spend as $0.
        if (cost != null) response.cost = cost;
        if (toolCalls.length > 0) {
          response.toolCalls = toolCalls;
        }
        return response;
      } catch (err) {
        throw mapBedrockError(err);
      }
    },

    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      await ensurePricing();
      const modelId = request.model ?? defaultModel;
      const messages = toBedrockMessages(request);
      const system: SystemContentBlock[] | undefined = request.system
        ? [{ text: request.system }]
        : undefined;
      const inferenceConfig: { maxTokens?: number; temperature?: number } = {};
      if (request.maxTokens != null) inferenceConfig.maxTokens = request.maxTokens;
      if (request.temperature != null) inferenceConfig.temperature = request.temperature;
      const toolConfig = buildToolConfig(request);

      let usage = emptyUsage();
      let finishReason = 'stop';
      const toolCalls: AIToolCall[] = [];
      /** Accumulate streamed tool-use input JSON by content-block index. */
      const toolInputByIndex = new Map<number, { id: string; name: string; raw: string }>();

      try {
        const out = await client.send(
          new ConverseStreamCommand({
            modelId,
            messages,
            system,
            inferenceConfig: Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined,
            toolConfig,
            outputConfig: buildOutputConfig(request, structuredOutputs),
          }),
          {
            abortSignal: combineAbort(
              request.signal,
              AbortSignal.timeout(request.timeout ?? defaultTimeout),
            ),
          },
        );

        if (!out.stream) {
          yield { type: 'error', error: 'Bedrock ConverseStream returned no stream' };
          return;
        }

        for await (const event of out.stream) {
          // ConverseStream models its failures as members of the event union
          // rather than throwing, so an unhandled one would end the loop and be
          // reported as a clean `done` with truncated content.
          const streamError = streamEventError(event);
          if (streamError) {
            yield { type: 'error', error: streamError };
            return;
          }
          if (event.contentBlockDelta?.delta?.text) {
            yield { type: 'content_delta', delta: event.contentBlockDelta.delta.text };
          }
          const blockIndex = event.contentBlockStart?.contentBlockIndex;
          if (event.contentBlockStart?.start?.toolUse) {
            const tu = event.contentBlockStart.start.toolUse;
            const id = tu.toolUseId ?? `tool_${tu.name ?? 'unknown'}`;
            const name = tu.name ?? '';
            const idx = blockIndex ?? toolInputByIndex.size;
            toolInputByIndex.set(idx, { id, name, raw: '' });
          }
          if (event.contentBlockDelta?.delta?.toolUse?.input != null) {
            const idx = event.contentBlockDelta.contentBlockIndex ?? -1;
            const entry = toolInputByIndex.get(idx);
            if (entry) {
              entry.raw += String(event.contentBlockDelta.delta.toolUse.input);
            }
          }
          if (event.contentBlockStop && event.contentBlockStop.contentBlockIndex != null) {
            const entry = toolInputByIndex.get(event.contentBlockStop.contentBlockIndex);
            if (entry) {
              try {
                toolCalls.push({
                  id: entry.id,
                  name: entry.name,
                  argumentsStatus: 'parsed',
                  arguments: entry.raw ? (JSON.parse(entry.raw) as Record<string, unknown>) : {},
                });
              } catch (err) {
                toolCalls.push({
                  id: entry.id,
                  name: entry.name,
                  argumentsStatus: 'invalid',
                  rawArguments: entry.raw,
                  parseError: err instanceof Error ? err.message : String(err),
                });
              }
              toolInputByIndex.delete(event.contentBlockStop.contentBlockIndex);
            }
          }
          if (event.metadata?.usage) {
            usage = mapUsage(event.metadata.usage);
            yield { type: 'usage', usage };
          }
          if (event.messageStop?.stopReason) {
            finishReason = mapStopReason(event.messageStop.stopReason);
          }
        }

        // Flush any tool starts that never got a contentBlockStop (name-only stubs).
        for (const entry of toolInputByIndex.values()) {
          if (!toolCalls.some((t) => t.id === entry.id)) {
            toolCalls.push({
              id: entry.id,
              name: entry.name,
              argumentsStatus: 'parsed',
              arguments: {},
            });
          }
        }

        const cost = pricing.calculateCost(modelId, usage);
        const done: ProviderStreamEvent = {
          type: 'done',
          usage,
          finishReason,
        };
        if (cost != null) done.cost = cost;
        if (toolCalls.length > 0) done.toolCalls = toolCalls;
        yield done;
      } catch (err) {
        yield {
          type: 'error',
          error: mapBedrockError(err).message,
        };
      }
    },

    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      await ensurePricing();
      const modelId = request.model ?? defaultEmbeddingModel;
      const embeddings: number[][] = new Array<number[]>(request.texts.length);
      let totalTokens = 0;

      async function embedOne(text: string, index: number): Promise<void> {
        const out = await client.send(
          new InvokeModelCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: new TextEncoder().encode(JSON.stringify(embeddingBody(modelId, text, inputType))),
          }),
          { abortSignal: AbortSignal.timeout(defaultTimeout) },
        );
        const parsed = parseEmbeddingResponse(out.body);
        embeddings[index] = parsed.embedding;
        totalTokens += parsed.tokens;
      }

      try {
        // Titan accepts one text per InvokeModel call, so a corpus ingest is N
        // round trips — run a bounded number concurrently while keeping output
        // order aligned with `request.texts`.
        const queue = request.texts.map((text, index) => ({ text, index }));
        let cursor = 0;
        const workers = Math.min(embedConcurrency, queue.length);
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (cursor < queue.length) {
              const item = queue[cursor++];
              if (!item) break;
              await embedOne(item.text, item.index);
            }
          }),
        );
      } catch (err) {
        throw mapBedrockError(err);
      }

      const cost = pricing.calculateCost(modelId, {
        inputTokens: totalTokens,
        outputTokens: 0,
      });

      const response: EmbeddingResponse = {
        embeddings,
        model: modelId,
        usage: { totalTokens },
      };
      if (cost != null) response.cost = cost;
      return response;
    },

    async listModels(filter?: ListModelsFilter): Promise<ProviderModel[]> {
      // Contract (AIProviderAdapter): never throw — warn once and return [].
      // Inference still fails loudly on a bad pricing file; only discovery is
      // degraded, since a missing rate is not a reason to break model listing.
      try {
        await ensurePricing();
      } catch (err) {
        console.warn(
          `[plumbus/ai-bedrock] listModels could not load pricing: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
      const entries = pricing.listRates().map(({ id, rate }) => ({
        id,
        rate: {
          inputPerMTok: rate.inputPerMTok,
          outputPerMTok: rate.outputPerMTok,
          kind: rate.kind,
        },
      }));
      // Prefer family keys (dedupe versioned duplicates from file).
      const byFamily = new Map<string, (typeof entries)[number]>();
      for (const e of entries) {
        const family = normalizeBedrockModelId(e.id);
        if (!byFamily.has(family)) byFamily.set(family, { ...e, id: family });
      }
      return filterModels([...byFamily.values()], filter);
    },
  };
}
