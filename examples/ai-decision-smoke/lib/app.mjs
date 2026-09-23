import {
  createErrorService,
  createExecutionContext,
  createLayaDecisionAdapter,
  createTypeSafeDecisionAdapter,
  defineCapability,
  executeCapability,
  z,
} from './deps.mjs';

export const defaultMessage =
  'I was charged twice for my order. Please refund the duplicate charge.';

/** Inject the provider boundary; application behavior runs through a capability. */
export function buildApp(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const options = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: 120_000,
    fetch: fetchImpl,
  };
  const adapters = {
    laya: createLayaDecisionAdapter(options),
    typesafe: createTypeSafeDecisionAdapter(options),
  };
  const capability = defineCapability({
    name: 'classifyTicket',
    domain: 'smoke',
    kind: 'query',
    description: 'Exercise one selected decision adapter against the local Laya model.',
    input: z.object({ via: z.enum(['laya', 'typesafe']), message: z.string().min(1).max(4000) }),
    output: z.object({
      provider: z.string(),
      model: z.string(),
      answers: z.record(z.unknown()),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        totalTokens: z.number(),
      }),
      cost: z.number().nullable(),
      costAvailable: z.boolean(),
      latencyMs: z.number(),
      routing: z.object({ model: z.string(), repo: z.string(), reason: z.string() }),
    }),
    access: { roles: ['smoke-tester'] },
    effects: { data: [], events: [], external: ['local-laya'], ai: true },
    audit: { enabled: false, event: 'smoke.decision' },
    async handler(ctx, input) {
      return adapters[input.via].decide({
        state: { text: input.message },
        signal: ctx.signal,
        questions: {
          department: {
            type: 'choice',
            instructions: 'Which team handles this request?',
            criteria: {
              billing: 'Payments and refunds',
              technical: 'Software bugs',
              other: 'Other requests',
            },
          },
          urgency: {
            type: 'score',
            instructions: 'How urgent is this request?',
            criteria: ['Routine', 'Time sensitive', 'Emergency'],
          },
          refund: {
            type: 'probability',
            instructions: 'Does the customer explicitly request a refund?',
          },
        },
      });
    },
  });
  function createContext(roles = ['smoke-tester']) {
    return createExecutionContext({
      auth: {
        userId: 'local-smoke',
        roles,
        scopes: [],
        tenantId: 'local-smoke',
        provider: 'smoke',
      },
      data: {},
      audit: { async record() {} },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  }
  return {
    capability,
    createContext,
    run: (via, message = defaultMessage) =>
      executeCapability(capability, createContext(), { via, message }),
  };
}

/** Two real inference calls plus checks that denial paths never need inference. */
export async function runSmoke(
  config,
  { message = defaultMessage, fetch: fetchImpl = globalThis.fetch } = {},
) {
  const app = buildApp(config, { fetch: fetchImpl });
  const denied = await executeCapability(app.capability, app.createContext([]), {
    via: 'laya',
    message,
  });
  if (denied.success)
    throw createErrorService().internal('Smoke failed: capability access denial was bypassed');
  const invalid = await app.run('laya', '');
  if (invalid.success)
    throw createErrorService().internal('Smoke failed: invalid input was accepted');

  const unauthorized = await fetchImpl(`${config.baseUrl}/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: '', questions: { p: { type: 'noul', instructions: '?' } } }),
    signal: AbortSignal.timeout(5000),
  });
  await unauthorized.body?.cancel();
  if (unauthorized.status !== 401)
    throw createErrorService().internal(
      'Smoke failed: service must reject requests without its password',
    );

  const results = [];
  for (const via of ['laya', 'typesafe']) {
    const result = await app.run(via, message);
    if (!result.success)
      throw createErrorService().internal(`Smoke failed through ${via}: ${result.error.message}`);
    if (result.data.usage.totalTokens <= 0 || result.data.routing.model !== config.model)
      throw createErrorService().internal(
        `Smoke failed through ${via}: missing usage or incorrect checkpoint`,
      );
    results.push(result.data);
  }
  return {
    checks: [
      'capability access denied',
      'invalid input rejected',
      'missing server password rejected',
      'Laya inference',
      'TypeSafe adapter against Laya',
    ],
    results,
  };
}
