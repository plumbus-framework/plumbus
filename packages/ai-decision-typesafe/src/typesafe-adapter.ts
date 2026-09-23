import {
  createDecisionHttpTransport,
  DecisionProviderError,
  DecisionJsonSchema,
  parseDecisionResponse,
  toSystemOneQuestions,
  validateDecisionRequest,
  type DecisionHttpConfig,
  type DecisionProviderAdapter,
} from '@plumbus/ai-decision';
import { z } from '@plumbus/core/zod';

export interface TypeSafeDecisionAdapterConfig
  extends Omit<DecisionHttpConfig, 'baseUrl' | 'apiKey'> {
  apiKey: string;
  /** API prefix, normally https://api.typesafe.ai/v1. */
  baseUrl?: string;
  model?: string;
  /** Input USD / million tokens, keyed by the actual response model ID. */
  inputRates?: Readonly<Record<string, number>>;
}

/** Source: https://docs.typesafe.ai/models, verified 2026-09-22. Output tokens are free. */
export const TypeSafeDecisionInputRates = Object.freeze({ 'jev-1.13.0': 0.042 });

/** Creates a TypeSafe System One HTTP adapter without installing a vendor SDK. */
export function createTypeSafeDecisionAdapter(
  config: TypeSafeDecisionAdapterConfig,
): DecisionProviderAdapter {
  const settings = z
    .object({
      apiKey: z.string().min(1),
      model: z.string().trim().min(1).max(256).default('jev-latest'),
      inputRates: DecisionJsonSchema.pipe(z.record(z.number().finite().nonnegative())).optional(),
    })
    .safeParse(config);
  if (!settings.success)
    throw new DecisionProviderError(
      'typesafe',
      'configuration',
      'TypeSafe requires an API key and valid model/pricing configuration',
    );
  const rates: Record<string, number> = {
    ...TypeSafeDecisionInputRates,
    ...settings.data.inputRates,
  };
  const post = createDecisionHttpTransport('typesafe', {
    ...config,
    apiKey: settings.data.apiKey,
    baseUrl: config.baseUrl === undefined ? 'https://api.typesafe.ai/v1' : config.baseUrl,
  });

  return {
    name: 'typesafe',
    async decide(request) {
      const input = validateDecisionRequest(request, 'typesafe');
      const start = performance.now();
      const wire = await post(
        {
          state: input.state,
          questions: toSystemOneQuestions(input.questions),
          model: input.model ?? settings.data.model,
        },
        input,
      );
      let result: ReturnType<typeof parseDecisionResponse<typeof input.questions>>;
      try {
        result = parseDecisionResponse(wire, input.questions, 'typesafe');
      } catch (error) {
        if (error instanceof DecisionProviderError && error.model && error.usage) {
          const rate = Object.hasOwn(rates, error.model) ? rates[error.model] : undefined;
          const cost = rate === undefined ? null : (error.usage.inputTokens / 1_000_000) * rate;
          const validCost =
            cost !== null &&
            Number.isFinite(cost) &&
            (cost > 0 || error.usage.inputTokens === 0 || rate === 0)
              ? cost
              : null;
          throw new DecisionProviderError('typesafe', error.kind, error.message, {
            model: error.model,
            usage: error.usage,
            cost: validCost,
          });
        }
        throw error;
      }
      const rate = Object.hasOwn(rates, result.model) ? rates[result.model] : undefined;
      const cost = rate === undefined ? null : (result.usage.inputTokens / 1_000_000) * rate;
      if (
        cost !== null &&
        (!Number.isFinite(cost) ||
          (cost === 0 && result.usage.inputTokens > 0 && rate !== undefined && rate > 0))
      )
        throw new DecisionProviderError(
          'typesafe',
          'configuration',
          'TypeSafe cost estimate cannot be represented',
          { usage: result.usage, model: result.model },
        );
      return {
        ...result,
        cost,
        costAvailable: cost !== null,
        latencyMs: performance.now() - start,
      };
    },
  };
}
