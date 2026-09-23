/** Execute one validated decision through core's security, budget, and cost hooks. */
import { z } from '@plumbus/core/zod';
import { defineDecision, DecisionRegistry } from './definition.js';
import { DecisionProviderError } from './errors/index.js';
import type {
  DecisionCall,
  DecisionDefinition,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  DecisionRuntimeConfig,
  DecisionRuntimeHooks,
  DecisionState,
} from './types.js';
import {
  readDecisionFailureMetadata,
  validateDecisionRequest,
  validateDecisionResult,
} from './validation.js';

const CallSchema = z
  .object({
    provider: z.string().trim().min(1).max(256).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    decision: z.union([z.string().trim().min(1).max(256), z.object({}).passthrough()]).optional(),
    questions: z.object({}).passthrough().optional(),
  })
  .refine((call) => (call.decision !== undefined) !== (call.questions !== undefined));

export async function runDecision<Q extends DecisionQuestions>(
  call: DecisionCall<Q>,
  config: DecisionRuntimeConfig | undefined,
  hooks: DecisionRuntimeHooks,
): Promise<DecisionResult<Q>> {
  const parsedCall = CallSchema.safeParse(call);
  if (!config || !parsedCall.success)
    throw new DecisionProviderError(
      'decision',
      'configuration',
      'Configure decision providers and supply a decision or questions',
    );
  const registry = new DecisionRegistry();
  for (const definition of config.definitions ?? []) registry.register(definition);
  const definition =
    parsedCall.data.decision === undefined
      ? undefined
      : defineDecision(
          typeof parsedCall.data.decision === 'string'
            ? (registry.has(parsedCall.data.decision)
                ? registry
                : (config.registry ?? registry)
              ).get(parsedCall.data.decision)
            : (call.decision as DecisionDefinition),
        );
  const providerKey = parsedCall.data.provider ?? definition?.provider ?? config.defaultProvider;
  const provider =
    providerKey && Object.hasOwn(config.providers, providerKey)
      ? config.providers[providerKey]
      : undefined;
  if (!provider)
    throw new DecisionProviderError(
      'decision',
      'configuration',
      'Decision provider is not registered',
    );
  // Adapter identity belongs to this dispatch, even if its owner replaces metadata later.
  const providerName = provider.name;
  const model = parsedCall.data.model ?? definition?.model ?? config.defaultModel;
  let state: unknown;
  try {
    state = definition?.state ? definition.state.parse(call.state) : call.state;
  } catch {
    throw new DecisionProviderError(
      providerName,
      'invalid_request',
      'State does not match the decision schema',
    );
  }
  // Validate/snapshot before security scanning, and scan structured questions too.
  const request = validateDecisionRequest(
    {
      state: state as DecisionState,
      questions: (definition?.questions ?? call.questions) as Q,
      model,
      signal: call.signal,
      timeoutMs: call.timeoutMs,
    },
    providerName,
  );
  const secured = hooks.secure({ state: request.state, questions: request.questions });
  const input = validateDecisionRequest(
    { ...request, ...secured } as DecisionRequest<Q>,
    providerName,
  );
  if (input.signal?.aborted)
    throw new DecisionProviderError(
      providerName,
      'cancelled',
      'Decision cancelled before dispatch',
    );
  hooks.checkBudget(
    Math.ceil(
      Buffer.byteLength(
        JSON.stringify({ state: input.state, questions: input.questions }),
        'utf8',
      ) / 4,
    ),
  );

  const started = performance.now();
  let result: DecisionResult<Q>;
  try {
    // Keep the validation contract separate from the adapter-owned request object.
    const dispatched = validateDecisionRequest(input, providerName);
    result = validateDecisionResult(
      await provider.decide(dispatched),
      input.questions,
      providerName,
    );
  } catch (error) {
    const metadata = readDecisionFailureMetadata(error);
    await hooks.record({
      provider: providerName,
      model: metadata.model ?? model ?? 'unknown',
      decisionName: definition?.name,
      usage: metadata.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: metadata.cost ?? null,
      latencyMs: performance.now() - started,
      status: 'failed',
      // Provider messages may contain caller content or HTTP response bodies.
      errorMessage:
        error instanceof DecisionProviderError
          ? `Decision provider ${error.kind}`
          : 'Decision provider failed',
    });
    throw error;
  }
  await hooks.record({
    provider: providerName,
    model: result.model,
    decisionName: definition?.name,
    usage: result.usage,
    cost: result.cost,
    latencyMs: performance.now() - started,
    status: 'success',
  });
  return result;
}
