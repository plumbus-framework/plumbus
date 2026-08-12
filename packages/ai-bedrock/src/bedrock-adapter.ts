import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ContentBlock,
  type Message,
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
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: raw.totalTokens ?? inputTokens + outputTokens,
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

function toToolChoice(choice: AIToolChoice | undefined): ToolChoice | undefined {
  if (choice == null || choice === 'auto') return { auto: {} };
  if (choice === 'none') return { any: {} }; // Bedrock has no true "none"; omit tools instead at call site
  if (typeof choice === 'object' && choice.type === 'function') {
    return { tool: { name: choice.function.name } };
  }
  return { auto: {} };
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
  return {
    tools: toBedrockTools(request.tools),
    toolChoice: toToolChoice(request.toolChoice),
  };
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

function toBedrockMessages(request: ProviderRequest): Message[] {
  const messages: Message[] = [];
  if (request.messages && request.messages.length > 0) {
    for (const msg of request.messages) {
      messages.push(chatMessageToBedrock(msg));
    }
    return messages;
  }
  messages.push({ role: 'user', content: [{ text: request.prompt }] });
  return messages;
}

function chatMessageToBedrock(msg: ChatMessage): Message {
  if (msg.role === 'user') {
    return { role: 'user', content: [{ text: msg.content }] };
  }
  if (msg.role === 'assistant') {
    const content: ContentBlock[] = [];
    if (msg.content) content.push({ text: msg.content });
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      content.push(...assistantContentFromToolCalls(msg.toolCalls));
    }
    return { role: 'assistant', content: content.length > 0 ? content : [{ text: '' }] };
  }
  // tool observation
  const toolResult: ToolResultContentBlock = { text: msg.content };
  return {
    role: 'user',
    content: [
      {
        toolResult: {
          toolUseId: msg.toolCallId,
          content: [toolResult],
        },
      },
    ],
  };
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
      return 'length';
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
          cost,
        };
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
          cost,
        };
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
      const embeddings: number[][] = [];
      let totalTokens = 0;

      try {
        for (const text of request.texts) {
          const body = {
            inputText: text,
          };
          const out = await client.send(
            new InvokeModelCommand({
              modelId,
              contentType: 'application/json',
              accept: 'application/json',
              body: new TextEncoder().encode(JSON.stringify(body)),
            }),
            { abortSignal: AbortSignal.timeout(defaultTimeout) },
          );
          const parsed = JSON.parse(new TextDecoder().decode(out.body)) as {
            embedding?: number[];
            inputTextTokenCount?: number;
          };
          if (!parsed.embedding) {
            throw new Error('Bedrock embedding response missing embedding vector');
          }
          embeddings.push(parsed.embedding);
          totalTokens += parsed.inputTextTokenCount ?? 0;
        }
      } catch (err) {
        throw mapBedrockError(err);
      }

      const cost = pricing.calculateCost(modelId, {
        inputTokens: totalTokens,
        outputTokens: 0,
      });

      return {
        embeddings,
        model: modelId,
        usage: { totalTokens },
        cost,
      };
    },

    async listModels(filter?: ListModelsFilter): Promise<ProviderModel[]> {
      await ensurePricing();
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
