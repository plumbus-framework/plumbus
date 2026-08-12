// Resolves smoke config from the environment. Secrets stay in .env (gitignored).
//
// Two auth modes (pick one):
//   1. mantle  — OPENAI_API_KEY + OPENAI_BASE_URL (bedrock-mantle.*.api.aws)
//                Uses core createOpenAIAdapter. Does NOT exercise @plumbus/ai-bedrock.
//   2. runtime — IAM / AWS keys + AI_BEDROCK_REGION
//                Uses createBedrockAdapter (Converse / InvokeModel + package pricing).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = path.join(appRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

function requiredOneOf(names, hint) {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim().length > 0) return v.trim();
  }
  throw new Error(
    `Missing required env: set one of ${names.join(', ')}.\n${hint}\n` +
      'Copy .env.example to .env and fill it in (do not commit .env).',
  );
}

/** Redact a secret for display — never log full keys. */
export function mask(secret) {
  if (!secret) return '(none)';
  if (secret.length <= 12) return '••••';
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

function isMantleBaseUrl(url) {
  return /bedrock-mantle\.[a-z0-9-]+\.api\.aws/i.test(url);
}

function regionFromMantleUrl(url) {
  const m = url.match(/bedrock-mantle\.([a-z0-9-]+)\.api\.aws/i);
  return m?.[1];
}

/**
 * Build the resolved smoke config from the environment.
 * Prefer Mantle when OPENAI_API_KEY + OPENAI_BASE_URL (mantle host) are set.
 */
export function loadConfig() {
  const openaiKey = optional('OPENAI_API_KEY', undefined);
  const openaiBase = optional('OPENAI_BASE_URL', undefined)?.replace(/\/$/, '');
  const forceMode = optional('BEDROCK_SMOKE_MODE', undefined); // mantle | runtime

  const wantMantle =
    forceMode === 'mantle' ||
    (forceMode !== 'runtime' &&
      Boolean(openaiKey) &&
      Boolean(openaiBase) &&
      isMantleBaseUrl(openaiBase));

  if (wantMantle) {
    if (!openaiKey || !openaiBase) {
      throw new Error(
        'Mantle mode needs OPENAI_API_KEY and OPENAI_BASE_URL ' +
          '(e.g. https://bedrock-mantle.eu-north-1.api.aws/v1).',
      );
    }
    if (!isMantleBaseUrl(openaiBase)) {
      throw new Error(
        `OPENAI_BASE_URL does not look like a Bedrock Mantle endpoint: ${openaiBase}`,
      );
    }
    const region =
      optional('AI_BEDROCK_REGION', undefined) ??
      optional('AWS_REGION', undefined) ??
      regionFromMantleUrl(openaiBase) ??
      'unknown';

    return {
      mode: 'mantle',
      region,
      baseUrl: openaiBase,
      apiKey: openaiKey,
      // Mantle /v1/models returns family ids. Anthropic Claude ids on Mantle often
      // reject /v1/chat/completions (Responses API only) — default to a chat-capable model.
      model: optional(
        'AI_BEDROCK_MODEL',
        optional('OPENAI_MODEL', 'qwen.qwen3-32b'),
      ),
      embeddingModel: optional(
        'AI_BEDROCK_EMBEDDING_MODEL',
        optional('OPENAI_EMBEDDING_MODEL', undefined),
      ),
      // Core MODEL_PRICING usually has $0 for Bedrock ids — assert usage only.
      requireCost: false,
      // Mantle catalogs are often chat-only; embed is optional unless a model is set.
      requireEmbed: Boolean(
        optional('AI_BEDROCK_EMBEDDING_MODEL', undefined) ??
          optional('OPENAI_EMBEDDING_MODEL', undefined),
      ),
    };
  }

  const region = requiredOneOf(
    ['AI_BEDROCK_REGION', 'AWS_REGION'],
    'For console Bedrock API keys (OPENAI_API_KEY + bedrock-mantle URL), use Mantle mode instead.',
  );

  const bearerToken = optional('AWS_BEARER_TOKEN_BEDROCK', undefined);
  const accessKeyId = optional('AWS_ACCESS_KEY_ID', undefined);
  const secretAccessKey = optional('AWS_SECRET_ACCESS_KEY', undefined);
  const sessionToken = optional('AWS_SESSION_TOKEN', undefined);
  const profile = optional('AWS_PROFILE', undefined);

  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new Error(
      'Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither (use AWS_PROFILE / AWS_BEARER_TOKEN_BEDROCK).',
    );
  }

  if (!accessKeyId && !profile && !bearerToken) {
    console.warn(
      '[config] No AWS_ACCESS_KEY_ID / AWS_PROFILE / AWS_BEARER_TOKEN_BEDROCK — AWS SDK default chain will be used.',
    );
  }

  const defaultPricingFile = path.join(appRoot, 'lib/pricing.fixture.json');

  return {
    mode: 'runtime',
    region,
    // Prefer inference-profile / regional ids for Converse in eu-north-1.
    model: optional('AI_BEDROCK_MODEL', 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'),
    embeddingModel: optional('AI_BEDROCK_EMBEDDING_MODEL', 'amazon.titan-embed-text-v2:0'),
    pricingFilePath: optional('AI_BEDROCK_PRICING_FILE', defaultPricingFile),
    credentials: accessKeyId
      ? {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        }
      : undefined,
    profile,
    accessKeyId,
    bearerToken: Boolean(bearerToken),
    requireCost: true,
    requireEmbed: true,
  };
}
