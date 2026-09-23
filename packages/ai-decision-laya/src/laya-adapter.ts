import {
  createDecisionHttpTransport,
  DecisionProviderError,
  parseDecisionResponse,
  toSystemOneQuestions,
  validateDecisionRequest,
  type DecisionHttpConfig,
  type DecisionProviderAdapter,
} from '@plumbus/ai-decision';
import { z } from '@plumbus/core/zod';

export interface LayaDecisionAdapterConfig extends DecisionHttpConfig {
  /** auto routes by language; otherwise selects a configured checkpoint. */
  model?: string;
  language?: string;
  /** Operator-supplied infrastructure estimate. Omit to report unknown cost. */
  costPerRequestUsd?: number;
}

/** Calls the persistent Python service shipped in this package's service/ directory. */
export function createLayaDecisionAdapter(
  config: LayaDecisionAdapterConfig,
): DecisionProviderAdapter {
  const settings = z
    .object({
      model: z.string().trim().min(1).max(256).default('auto'),
      language: z.string().trim().min(1).max(64).optional(),
      costPerRequestUsd: z.number().finite().nonnegative().optional(),
    })
    .safeParse(config);
  if (!settings.success)
    throw new DecisionProviderError(
      'laya',
      'configuration',
      'Invalid Laya model, language, or cost configuration',
    );
  const post = createDecisionHttpTransport('laya', config);
  return {
    name: 'laya',
    async decide(request) {
      const input = validateDecisionRequest(request, 'laya');
      const start = performance.now();
      const model = input.model ?? settings.data.model;
      const wire = await post(
        {
          state: input.state,
          questions: toSystemOneQuestions(input.questions),
          ...(model === 'auto' ? {} : { model }),
          ...(settings.data.language ? { lang: settings.data.language } : {}),
        },
        input,
      );
      let result: ReturnType<typeof parseDecisionResponse<typeof input.questions>>;
      try {
        result = parseDecisionResponse(wire, input.questions, 'laya');
      } catch (error) {
        if (error instanceof DecisionProviderError && error.usage && error.model) {
          throw new DecisionProviderError('laya', error.kind, error.message, {
            model: error.model,
            usage: error.usage,
            cost: settings.data.costPerRequestUsd ?? null,
          });
        }
        throw error;
      }
      if (!z.object({ routing: z.object({}) }).safeParse(result).success) {
        throw new DecisionProviderError(
          'laya',
          'invalid_response',
          'Laya response is missing checkpoint routing identity',
          {
            model: result.model,
            usage: result.usage,
            cost: settings.data.costPerRequestUsd ?? null,
          },
        );
      }
      const cost = settings.data.costPerRequestUsd ?? null;
      return {
        ...result,
        cost,
        costAvailable: cost !== null,
        latencyMs: performance.now() - start,
      };
    },
  };
}
