import { describe, expect, it } from 'vitest';
import { loadConfig } from '../loader.js';

/** The env that turns each provider slot on, and where its loaded config lands. */
const SLOTS = {
  'AI_ (single provider)': {
    prefix: 'AI_',
    env: { AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test' },
    read: (config: ReturnType<typeof loadConfig>) => config.ai,
  },
  AI_OPENAI_: {
    prefix: 'AI_OPENAI_',
    env: { AI_DEFAULT_PROVIDER: 'openai', AI_OPENAI_API_KEY: 'sk-test' },
    read: (config: ReturnType<typeof loadConfig>) => config.aiProviders?.providers.openai,
  },
  AI_ANTHROPIC_: {
    prefix: 'AI_ANTHROPIC_',
    env: { AI_DEFAULT_PROVIDER: 'anthropic', AI_ANTHROPIC_API_KEY: 'sk-ant-test' },
    read: (config: ReturnType<typeof loadConfig>) => config.aiProviders?.providers.anthropic,
  },
  AI_BEDROCK_: {
    prefix: 'AI_BEDROCK_',
    env: { AI_DEFAULT_PROVIDER: 'bedrock', AI_BEDROCK_REGION: 'us-east-1' },
    read: (config: ReturnType<typeof loadConfig>) => config.aiProviders?.providers.bedrock,
  },
} as const;

const slots = Object.entries(SLOTS);

function load(env: Record<string, string>) {
  return loadConfig({ environment: 'development', env });
}

describe.each(slots)('provider limits from env: %s', (_label, slot) => {
  const timeoutVar = `${slot.prefix}REQUEST_TIMEOUT`;
  const maxTokensVar = `${slot.prefix}MAX_TOKENS`;
  const costVar = `${slot.prefix}DAILY_COST_LIMIT`;

  it('reads plain numbers (surrounding spaces ignored)', () => {
    const provider = slot.read(
      load({
        ...slot.env,
        [timeoutVar]: ' 600000 ',
        [maxTokensVar]: '4096',
        [costVar]: '10.5',
      }),
    );
    expect(provider).toMatchObject({
      requestTimeout: 600_000,
      maxTokensPerRequest: 4096,
      dailyCostLimit: 10.5,
    });
  });

  it('treats unset and blank values as unset', () => {
    const provider = slot.read(load({ ...slot.env, [timeoutVar]: '', [maxTokensVar]: '  ' }));
    expect(provider?.requestTimeout).toBeUndefined();
    expect(provider?.maxTokensPerRequest).toBeUndefined();
    expect(provider?.dailyCostLimit).toBeUndefined();
  });

  it.each([
    'abc',
    '15m',
    '30s',
    '0',
    '-5',
    '1.5',
    '1e5',
    '2147483648',
  ])(`rejects ${timeoutVar}=%s, naming the variable`, (value) => {
    expect(() => load({ ...slot.env, [timeoutVar]: value })).toThrow(
      `Invalid ${timeoutVar}="${value}": expected a whole number of milliseconds from 1 to 2147483647`,
    );
  });

  it.each([
    'abc',
    '4k',
    '-1',
    '1.5',
    '4096tokens',
  ])(`rejects ${maxTokensVar}=%s, naming the variable`, (value) => {
    expect(() => load({ ...slot.env, [maxTokensVar]: value })).toThrow(
      `Invalid ${maxTokensVar}="${value}": expected a whole number of tokens, 0 or more`,
    );
  });

  it.each([
    'abc',
    '50$',
    '50usd',
    '-1',
    '1e3',
  ])(`rejects ${costVar}=%s, naming the variable`, (value) => {
    expect(() => load({ ...slot.env, [costVar]: value })).toThrow(
      `Invalid ${costVar}="${value}": expected a number of US dollars, 0 or more`,
    );
  });

  it('accepts 0 for the token and cost guards, as the cost tracker does', () => {
    const provider = slot.read(load({ ...slot.env, [maxTokensVar]: '0', [costVar]: '0' }));
    expect(provider).toMatchObject({ maxTokensPerRequest: 0, dailyCostLimit: 0 });
  });
});

describe('AI_BEDROCK_PRICING_TTL_MS', () => {
  it('reads a plain whole number of milliseconds', () => {
    const config = load({ ...SLOTS.AI_BEDROCK_.env, AI_BEDROCK_PRICING_TTL_MS: '86400000' });
    expect(config.aiProviders?.providers.bedrock?.pricingCacheTtlMs).toBe(86_400_000);
  });

  it.each(['abc', '24h', '-1', '1.5'])('rejects %s, naming the variable', (value) => {
    expect(() => load({ ...SLOTS.AI_BEDROCK_.env, AI_BEDROCK_PRICING_TTL_MS: value })).toThrow(
      `Invalid AI_BEDROCK_PRICING_TTL_MS="${value}": expected a whole number of milliseconds, 0 or more`,
    );
  });
});
