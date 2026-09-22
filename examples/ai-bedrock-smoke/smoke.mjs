#!/usr/bin/env node
// Live Amazon Bedrock smoke.
//
// Two modes (auto-detected from .env):
//   mantle  — OPENAI_API_KEY + OPENAI_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1
//             → createOpenAIAdapter (does NOT exercise @plumbus/ai-bedrock)
//   runtime — AI_BEDROCK_REGION + IAM AWS keys
//             → createBedrockAdapter (Converse / stream / embed + package cost)
//
//   1. pnpm --filter @plumbus/core --filter @plumbus/ai-bedrock build
//   2. cd examples/ai-bedrock-smoke && cp .env.example .env
//   3. node smoke.mjs
//
// Never prints secrets. Never fabricates model responses.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, mask } from './lib/config.mjs';
import { createBedrockAdapter, createOpenAIAdapter } from './lib/deps.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));

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

async function checkListModels(adapter, { requirePrices }) {
  if (!adapter.listModels) return fail('listModels', 'adapter has no listModels');
  const models = await adapter.listModels();
  if (!models || models.length === 0) {
    return fail(
      'listModels',
      requirePrices
        ? 'empty list (pricing fixture / warm failed?)'
        : 'empty list — check Mantle key / model access',
    );
  }
  if (requirePrices) {
    const priced = models.filter(
      (m) => typeof m.inputPerMTok === 'number' && typeof m.outputPerMTok === 'number',
    );
    if (priced.length === 0) {
      return fail('listModels', 'models present but no numeric prices');
    }
    const sample = priced[0];
    return ok(
      'listModels',
      `${priced.length} priced model(s); e.g. ${sample.id} in=$${sample.inputPerMTok}/MTok`,
    );
  }
  return ok('listModels', `${models.length} model(s); e.g. ${models[0]?.id}`);
}

async function checkComplete(adapter, model, { requireCost }) {
  const result = await adapter.complete({
    prompt: 'Reply with exactly the single word: pong',
    model,
    temperature: 0,
    maxTokens: 32,
  });
  const text = (result.content ?? '').trim();
  if (!text) return fail('complete', 'empty content');
  if (!result.usage || !(result.usage.totalTokens > 0)) {
    return fail('complete', `missing usage (got ${JSON.stringify(result.usage)})`);
  }
  if (requireCost && (typeof result.cost !== 'number' || !(result.cost > 0))) {
    return fail(
      'complete',
      `expected cost > 0 from pricing fixture (got ${String(result.cost)})`,
    );
  }
  const costPart =
    typeof result.cost === 'number' ? `  cost=$${result.cost}` : '';
  return ok(
    'complete',
    `"${text.slice(0, 48)}"  tokens=${result.usage.totalTokens}${costPart}`,
  );
}

async function checkStream(adapter, model, { requireCost }) {
  let deltas = 0;
  let done = null;
  let usage = null;
  for await (const ev of adapter.stream({
    prompt: 'Reply with exactly the single word: stream-ok',
    model,
    temperature: 0,
    maxTokens: 32,
  })) {
    if (ev.type === 'content_delta' && ev.delta) deltas += 1;
    if (ev.type === 'usage' && ev.usage) usage = ev.usage;
    if (ev.type === 'error') return fail('stream', ev.error ?? 'stream error event');
    if (ev.type === 'done') {
      done = ev;
      if (ev.usage) usage = ev.usage;
    }
  }
  if (deltas < 1) return fail('stream', 'no content_delta events');
  if (!done) return fail('stream', 'missing done event');
  // Mantle often sends usage as a separate SSE chunk after the finish_reason done.
  const finalUsage = usage ?? done.usage;
  if (!finalUsage || !(finalUsage.totalTokens > 0)) {
    return fail('stream', `missing usage (got ${JSON.stringify(finalUsage)})`);
  }
  if (requireCost && (typeof done.cost !== 'number' || !(done.cost > 0))) {
    return fail('stream', `expected cost > 0 on done (got ${String(done.cost)})`);
  }
  const costPart = typeof done.cost === 'number' ? `  cost=$${done.cost}` : '';
  return ok('stream', `deltas=${deltas}  tokens=${finalUsage.totalTokens}${costPart}`);
}

async function checkEmbed(adapter, embeddingModel, { requireCost, requireEmbed }) {
  if (!embeddingModel) {
    if (requireEmbed) return fail('embed', 'no embedding model configured');
    console.log('· embed          skipped (no embedding model on this Mantle catalog / unset)');
    return true;
  }
  if (typeof adapter.embed !== 'function') {
    return fail('embed', 'adapter has no embed()');
  }
  const result = await adapter.embed({
    texts: ['plumbus bedrock smoke'],
    model: embeddingModel,
  });
  const vec = result.embeddings?.[0];
  if (!vec || vec.length < 1) return fail('embed', 'empty embedding vector');
  const tokens = result.usage?.totalTokens ?? 0;
  if (requireCost) {
    if (typeof result.cost !== 'number' || Number.isNaN(result.cost) || result.cost < 0) {
      return fail('embed', `expected non-negative numeric cost (got ${String(result.cost)})`);
    }
    if (tokens > 0 && !(result.cost > 0)) {
      return fail('embed', `tokens=${tokens} but cost=${result.cost} (expected > 0)`);
    }
  }
  const costPart = typeof result.cost === 'number' ? `  cost=$${result.cost}` : '';
  return ok(
    'embed',
    `dims=${vec.length}  tokens=${tokens}${costPart}  model=${result.model ?? embeddingModel}`,
  );
}

function createAdapter(config) {
  if (config.mode === 'mantle') {
    return createOpenAIAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model,
    });
  }

  const pricingAbs = path.isAbsolute(config.pricingFilePath)
    ? config.pricingFilePath
    : path.resolve(appRoot, config.pricingFilePath);

  return {
    adapter: createBedrockAdapter({
      region: config.region,
      defaultModel: config.model,
      defaultEmbeddingModel: config.embeddingModel,
      pricingFilePath: pricingAbs,
      ...(config.credentials ? { credentials: config.credentials } : {}),
      warmPricingOnCreate: false,
    }),
    pricingAbs,
  };
}

async function main() {
  const config = loadConfig();
  const built = createAdapter(config);
  const adapter = config.mode === 'mantle' ? built : built.adapter;
  const requireCost = Boolean(config.requireCost);
  const requirePrices = config.mode === 'runtime';

  line();
  console.log('Plumbus Amazon Bedrock smoke');
  line();
  console.log(`  mode             : ${config.mode}`);
  if (config.mode === 'mantle') {
    console.log('  package under test: @plumbus/core createOpenAIAdapter → Bedrock Mantle');
    console.log('  NOTE              : This does NOT exercise @plumbus/ai-bedrock (Converse/IAM).');
    console.log(`  base URL          : ${config.baseUrl}`);
    console.log(`  api key           : ${mask(config.apiKey)}`);
  } else {
    console.log('  package under test: @plumbus/ai-bedrock (Converse / InvokeModel)');
    console.log(`  pricing file      : ${built.pricingAbs}`);
    console.log(
      `  credentials       : ${
        config.accessKeyId
          ? `access key ${mask(config.accessKeyId)}`
          : config.bearerToken
            ? 'AWS_BEARER_TOKEN_BEDROCK (set)'
            : config.profile
              ? `AWS_PROFILE=${config.profile}`
              : 'default SDK chain'
      }`,
    );
  }
  console.log(`  region           : ${config.region}`);
  console.log(`  chat model       : ${config.model}`);
  console.log(`  embedding model  : ${config.embeddingModel ?? '(none — skip)'}`);
  console.log(`  require cost > 0 : ${requireCost}`);
  line();

  const results = [];
  results.push(await checkListModels(adapter, { requirePrices }));
  results.push(await checkComplete(adapter, config.model, { requireCost }));
  results.push(await checkStream(adapter, config.model, { requireCost }));
  results.push(
    await checkEmbed(adapter, config.embeddingModel, {
      requireCost,
      requireEmbed: Boolean(config.requireEmbed),
    }),
  );

  line();
  const passed = results.every(Boolean);
  if (passed) {
    console.log(
      config.mode === 'mantle'
        ? 'PASS — Mantle complete/stream/embed/listModels OK (not @plumbus/ai-bedrock)'
        : 'PASS — @plumbus/ai-bedrock complete/stream/embed/listModels + cost OK',
    );
  } else {
    console.log('FAIL');
  }
  line();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  line();
  console.error('Smoke test failed:\n');
  console.error(err?.stack ?? String(err));
  const msg = String(err?.message ?? err);
  if (/401|Unauthorized|Invalid.*[Kk]ey|ExpiredToken|security token/i.test(msg)) {
    console.error(
      '\nAuth failed. For Mantle: refresh OPENAI_API_KEY in .env.\n' +
        'For runtime IAM: refresh AWS_ACCESS_KEY_ID / SECRET. Do not commit .env.',
    );
  }
  if (/AccessDenied|is not authorized|Model.*not.*found|ValidationException|404/i.test(msg)) {
    console.error(
      '\nModel or permission issue. Enable the model in Bedrock for this region,\n' +
        'or set AI_BEDROCK_MODEL / OPENAI_MODEL to an id from listModels.',
    );
  }
  process.exit(1);
});
