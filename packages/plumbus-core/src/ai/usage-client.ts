// ── Usage API Client ──
// Fetches actual usage and cost data from AI provider billing APIs.
// Supports OpenAI (/v1/organization/usage/completions) and Anthropic usage APIs.

// ── Types ──

export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  requestCount: number;
}

export interface UsageData {
  totalCost: number;
  currency: string;
  entries: UsageEntry[];
}

export interface UsageAPIClient {
  provider: string;
  fetchUsage(params: { startDate: Date; endDate: Date }): Promise<UsageData>;
}

export interface UsageClientConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  baseUrl?: string;
  organizationId?: string;
}

// ── OpenAI Usage API Client ──

function createOpenAIUsageClient(config: UsageClientConfig): UsageAPIClient {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com';

  return {
    provider: 'openai',

    async fetchUsage(params) {
      const startTime = Math.floor(params.startDate.getTime() / 1000);
      const endTime = Math.floor(params.endDate.getTime() / 1000);

      const url = new URL('/v1/organization/usage/completions', baseUrl);
      url.searchParams.set('start_time', String(startTime));
      url.searchParams.set('end_time', String(endTime));
      if (config.organizationId) {
        url.searchParams.set('project_ids', config.organizationId);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new UsageAPIError(
          'openai',
          `OpenAI Usage API returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as OpenAIUsageResponse;

      const entries: UsageEntry[] = [];
      let totalCost = 0;

      for (const bucket of data.data ?? []) {
        for (const result of bucket.results ?? []) {
          const cost = result.amount?.value ?? 0;
          totalCost += cost;
          entries.push({
            model: result.model ?? 'unknown',
            inputTokens: result.input_tokens ?? 0,
            outputTokens: result.output_tokens ?? 0,
            cost,
            requestCount: result.num_model_requests ?? 0,
          });
        }
      }

      return { totalCost, currency: 'usd', entries };
    },
  };
}

// ── Anthropic Usage API Client ──

function createAnthropicUsageClient(config: UsageClientConfig): UsageAPIClient {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';

  return {
    provider: 'anthropic',

    async fetchUsage(params) {
      const startDate = params.startDate.toISOString().split('T')[0];
      const endDate = params.endDate.toISOString().split('T')[0];

      const url = new URL('/v1/usage', baseUrl);
      url.searchParams.set('start_date', startDate ?? '');
      url.searchParams.set('end_date', endDate ?? '');

      const response = await fetch(url.toString(), {
        headers: {
          'x-api-key': config.apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        throw new UsageAPIError(
          'anthropic',
          `Anthropic Usage API returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as AnthropicUsageResponse;

      const entries: UsageEntry[] = [];
      let totalCost = 0;

      for (const entry of data.data ?? []) {
        const cost = entry.cost_usd ?? 0;
        totalCost += cost;
        entries.push({
          model: entry.model ?? 'unknown',
          inputTokens: entry.input_tokens ?? 0,
          outputTokens: entry.output_tokens ?? 0,
          cost,
          requestCount: entry.num_requests ?? 0,
        });
      }

      return { totalCost, currency: 'usd', entries };
    },
  };
}

// ── Factory ──

export function createUsageAPIClient(config: UsageClientConfig): UsageAPIClient {
  switch (config.provider) {
    case 'openai':
      return createOpenAIUsageClient(config);
    case 'anthropic':
      return createAnthropicUsageClient(config);
    default:
      throw new UsageAPIError(
        config.provider,
        `Unsupported usage API provider: ${config.provider}`,
      );
  }
}

// ── Error ──

export class UsageAPIError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'UsageAPIError';
  }
}

// ── Internal API response types ──

interface OpenAIUsageResponse {
  data?: Array<{
    results?: Array<{
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      num_model_requests?: number;
      amount?: { value: number; currency: string };
    }>;
  }>;
}

interface AnthropicUsageResponse {
  data?: Array<{
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    num_requests?: number;
    cost_usd?: number;
  }>;
}
