#!/usr/bin/env node
// Live TypeSafe (Jev) smoke. No fake model responses.
//
// Exercises both surfaces the package provides:
//   1. ctx.ai.decide()  — noul / choice / score through the decision adapter
//   2. ctx.ai.classify() — the native classify hook on the provider adapter
//   3. listModels()      — GET /v1/models
//   4. Local validation  — an over-limit rubric must fail before any network call
//   5. Generation        — must be rejected, because Jev produces no text
//
//   1. pnpm --filter @plumbus/core --filter @plumbus/ai-typesafe build
//   2. cd examples/ai-typesafe-smoke && cp .env.example .env
//   3. node smoke.mjs
//
// Never prints secrets. Exits 0 with a skip notice when no key is configured,
// so a contributor without a TypeSafe account can still run it.
import { mask, resolveConfig } from './lib/config.mjs';
import {
  choice,
  createAIService,
  createCostTracker,
  createTypeSafeAdapter,
  createTypeSafeDecisionAdapter,
  JEV_CAPABILITIES,
  noul,
  score,
} from './lib/deps.mjs';

function line() {
  console.log('─'.repeat(72));
}

function fail(step, detail) {
  console.error(`✗ ${step}  ${detail}`);
  return false;
}

function ok(step, detail) {
  console.log(`✓ ${step}  ${detail}`);
  return true;
}

const TICKET =
  'Help! My payouts have been failing for 3 days and nobody has replied. ' +
  'This is blocking payroll and I am getting extremely frustrated.';

async function checkDecide(ai) {
  const result = await ai.decide({
    state: TICKET,
    questions: {
      isUrgent: noul('Does this convey urgency?', {
        true: 'Explicitly time-sensitive',
        false: 'No urgency expressed',
      }),
      department: choice('Which team should handle this?', {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing, upgrades, new accounts',
      }),
      frustration: score('How frustrated is the customer?', ['Calm', 'Frustrated', 'Very angry']),
    },
  });

  const { answers } = result;

  if (typeof answers.isUrgent?.noul !== 'number') {
    return fail('decide/noul', `expected a number, got ${JSON.stringify(answers.isUrgent)}`);
  }
  if (typeof answers.department?.choice !== 'string') {
    return fail('decide/choice', `expected a string, got ${JSON.stringify(answers.department)}`);
  }
  if (typeof answers.frustration?.score !== 'number') {
    return fail('decide/score', `expected a number, got ${JSON.stringify(answers.frustration)}`);
  }
  if (!result.model.startsWith('jev-')) {
    return fail('decide/model', `expected a jev-* version, got ${result.model}`);
  }
  // An alias must resolve to a concrete version in the response.
  if (result.model === 'jev-latest' || result.model === 'jev-preview') {
    return fail('decide/model', `expected a resolved version, got the alias ${result.model}`);
  }
  if (result.usage.inputTokens <= 0) {
    return fail('decide/usage', `expected input tokens, got ${result.usage.inputTokens}`);
  }
  if (typeof result.cost !== 'number' || result.cost <= 0) {
    return fail('decide/cost', `expected a positive cost, got ${result.cost}`);
  }

  ok(
    'decide',
    `model=${result.model} urgent=${answers.isUrgent.noul.toFixed(2)} ` +
      `dept=${answers.department.choice}@${answers.department.confidence.toFixed(2)} ` +
      `frustration=${answers.frustration.score.toFixed(2)}`,
  );
  ok(
    'decide/accounting',
    `in=${result.usage.inputTokens} out=${result.usage.outputTokens} cost=$${result.cost.toFixed(8)}`,
  );

  // Sanity check the model actually read the state rather than answering blind.
  if (answers.isUrgent.noul < 0.5) {
    return fail(
      'decide/plausibility',
      `an explicitly blocked-and-frustrated ticket scored ${answers.isUrgent.noul.toFixed(2)} for urgency`,
    );
  }
  return ok('decide/plausibility', 'urgency reads above 0.5 on an obviously urgent ticket');
}

async function checkClassify(ai) {
  const labels = await ai.classify({
    labels: ['billing', 'technical', 'sales', 'spam'],
    text: TICKET,
  });

  if (!Array.isArray(labels)) {
    return fail('classify', `expected an array, got ${typeof labels}`);
  }
  for (const label of labels) {
    if (!['billing', 'technical', 'sales', 'spam'].includes(label)) {
      return fail('classify', `returned a label that was not requested: ${label}`);
    }
  }
  if (labels.includes('spam')) {
    return fail('classify', 'a genuine payout complaint was labelled spam');
  }
  return ok('classify', `native hook returned [${labels.join(', ')}]`);
}

async function checkListModels(adapter) {
  if (!adapter.listModels) return fail('listModels', 'adapter has no listModels');
  const models = await adapter.listModels();
  if (!models || models.length === 0) {
    return fail('listModels', 'empty list — check the API key and account access');
  }
  return ok('listModels', `${models.length} model(s); e.g. ${models[0]?.name}`);
}

async function checkLocalValidation(ai) {
  // 11 levels is over Jev's 2–10 range. This must fail locally, with no request.
  try {
    await ai.decide({
      state: TICKET,
      questions: {
        rating: score(
          'Rate it',
          Array.from({ length: JEV_CAPABILITIES.scoreLevels.max + 1 }, (_, i) => `level ${i}`),
        ),
      },
    });
    return fail('localValidation', 'an over-limit score rubric was accepted');
  } catch (err) {
    if (!/levels/.test(String(err.message))) {
      return fail('localValidation', `rejected, but not for the level count: ${err.message}`);
    }
    return ok('localValidation', 'over-limit rubric rejected before any network call');
  }
}

async function checkGenerationRejected(ai) {
  try {
    await ai.generate({ prompt: 'Write a haiku about payouts.', input: {} });
    return fail('generationRejected', 'generate() succeeded against a decision model');
  } catch (err) {
    if (!/does not support/.test(String(err.message))) {
      return fail('generationRejected', `rejected, but with an unclear message: ${err.message}`);
    }
    return ok('generationRejected', 'generate() rejected with a message naming the right surface');
  }
}

async function main() {
  line();
  console.log('TypeSafe (Jev) live smoke — @plumbus/ai-typesafe');
  line();

  const config = resolveConfig();
  if (!config.configured) {
    console.log('⊘ Skipped: no API key configured.');
    console.log('  Set AI_TYPESAFE_API_KEY (or TYPESAFE_API_KEY) in examples/ai-typesafe-smoke/.env');
    console.log('  Copy .env.example to .env and fill it in (do not commit .env).');
    line();
    process.exit(0);
  }

  console.log(`key:   ${mask(config.apiKey)}`);
  console.log(`model: ${config.model}`);
  if (config.baseUrl) console.log(`base:  ${config.baseUrl}`);
  line();

  const adapterConfig = {
    apiKey: config.apiKey,
    defaultModel: config.model,
    requestTimeout: config.requestTimeout,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };

  const decisionAdapter = createTypeSafeDecisionAdapter(adapterConfig);

  // TypeSafe is registered in BOTH slots here on purpose: as the decision
  // provider for decide(), and as the default chat provider so classify()
  // routes to its native hook. A real app that also generates text keeps a
  // text provider as the default — see docs/ai/typesafe.md.
  const ai = createAIService({
    providers: { typesafe: createTypeSafeAdapter(adapterConfig) },
    defaultProvider: 'typesafe',
    decisionProviders: { typesafe: decisionAdapter },
    defaultDecisionProvider: 'typesafe',
    defaultDecisionModel: config.model,
    costTracker: createCostTracker(),
  });

  const results = [];
  const steps = [
    ['decide', () => checkDecide(ai)],
    ['classify', () => checkClassify(ai)],
    ['listModels', () => checkListModels(decisionAdapter)],
    ['localValidation', () => checkLocalValidation(ai)],
    ['generationRejected', () => checkGenerationRejected(ai)],
  ];

  for (const [name, run] of steps) {
    try {
      results.push(await run());
    } catch (err) {
      results.push(fail(name, err instanceof Error ? err.message : String(err)));
    }
  }

  line();
  const passed = results.filter(Boolean).length;
  console.log(`${passed}/${results.length} checks passed`);
  line();
  process.exit(results.every(Boolean) ? 0 : 1);
}

await main();
