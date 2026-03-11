// ── AI Provider Adapter Interface ──
// Abstract interface for AI provider adapters (OpenAI, Anthropic, etc.)

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

// ── OpenAI Adapter ──
export interface OpenAIAdapterConfig {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  baseUrl?: string;
}

export function createOpenAIAdapter(config: OpenAIAdapterConfig): AIProviderAdapter {
  const defaultModel = config.model ?? 'gpt-4o';
  const defaultEmbeddingModel = config.embeddingModel ?? 'text-embedding-3-small';
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';

  return {
    name: 'openai',

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system) {
        messages.push({ role: 'system', content: request.system });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body: Record<string, unknown> = {
        model: request.model ?? defaultModel,
        messages,
        temperature: request.temperature ?? 0.7,
      };
      if (request.maxTokens) body.max_tokens = request.maxTokens;
      if (request.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`OpenAI API error (${resp.status}): ${text}`);
      }

      const data = (await resp.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
        model: string;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const choice = data.choices[0];
      if (!choice) throw new Error('OpenAI returned no choices');
      return {
        content: choice.message.content,
        model: data.model,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
        finishReason: choice.finish_reason,
      };
    },

    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system) {
        messages.push({ role: 'system', content: request.system });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body: Record<string, unknown> = {
        model: request.model ?? defaultModel,
        messages,
        temperature: request.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (request.maxTokens) body.max_tokens = request.maxTokens;
      if (request.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        yield { type: 'error', error: `OpenAI API error (${resp.status}): ${text}` };
        return;
      }

      yield* parseSSEStream(resp, parseOpenAISSEChunk);
    },

    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const body = {
        model: request.model ?? defaultEmbeddingModel,
        input: request.texts,
      };

      const resp = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`OpenAI Embedding API error (${resp.status}): ${text}`);
      }

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
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): AIProviderAdapter {
  const defaultModel = config.model ?? 'claude-sonnet-4-20250514';
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';

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

      const resp = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Anthropic API error (${resp.status}): ${text}`);
      }

      const data = (await resp.json()) as {
        content: Array<{ type: string; text: string }>;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
        stop_reason: string;
      };

      const text = data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');

      return {
        content: text,
        model: data.model,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        },
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

      const resp = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        yield { type: 'error', error: `Anthropic API error (${resp.status}): ${text}` };
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
      buffer = lines.pop()!; // Keep incomplete line in buffer

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
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
