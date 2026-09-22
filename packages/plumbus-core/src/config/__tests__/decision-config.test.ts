import { describe, expect, it, vi } from 'vitest';
import { loadDecisionOverrides, loadMultiProviderConfig } from '../loader.js';

describe('TypeSafe provider slot', () => {
  it('builds a slot from AI_TYPESAFE_*', () => {
    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_TYPESAFE_API_KEY: 'ts-test',
      AI_TYPESAFE_MODEL: 'jev-1.13.0',
      AI_TYPESAFE_BASE_URL: 'https://api.example.test',
      AI_TYPESAFE_REQUEST_TIMEOUT: '15000',
    });

    expect(config?.providers.typesafe).toMatchObject({
      provider: 'typesafe',
      apiKey: 'ts-test',
      model: 'jev-1.13.0',
      baseUrl: 'https://api.example.test',
      requestTimeout: 15000,
    });
  });

  it('accepts the SDK-native TYPESAFE_API_KEY', () => {
    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'typesafe',
      TYPESAFE_API_KEY: 'ts-test',
    });

    expect(config?.providers.typesafe?.apiKey).toBe('ts-test');
  });

  it('skips the slot when the key is blank', () => {
    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_TYPESAFE_API_KEY: '   ',
    });

    expect(config?.providers.typesafe).toBeUndefined();
  });

  it('no longer warns that AI_TYPESAFE_API_KEY is an unknown provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'typesafe',
      AI_TYPESAFE_API_KEY: 'ts-test',
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('decision provider config', () => {
  it('is absent until AI_DECISION_PROVIDER is set', () => {
    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_TYPESAFE_API_KEY: 'ts-test',
    });

    expect(config?.decisions).toBeUndefined();
  });

  it('reuses the chat-side slot credentials', () => {
    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_TYPESAFE_API_KEY: 'ts-test',
      AI_DECISION_PROVIDER: 'typesafe',
      AI_DECISION_MODEL: 'jev-latest',
    });

    expect(config?.decisions).toMatchObject({
      defaultProvider: 'typesafe',
      defaultModel: 'jev-latest',
    });
    expect(config?.decisions?.providers.typesafe?.apiKey).toBe('ts-test');
  });

  it('inherits AI_TYPESAFE_MODEL when AI_DECISION_MODEL is unset', () => {
    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'typesafe',
      AI_TYPESAFE_API_KEY: 'ts-test',
      AI_TYPESAFE_MODEL: 'jev-1.13.0',
      AI_DECISION_PROVIDER: 'typesafe',
    });

    expect(config?.decisions?.defaultModel).toBe('jev-1.13.0');
  });

  it('boots a decisions-only app that sets no AI_DEFAULT_PROVIDER', () => {
    const config = loadMultiProviderConfig({
      AI_TYPESAFE_API_KEY: 'ts-test',
      AI_DECISION_PROVIDER: 'typesafe',
    });

    expect(config?.defaultProvider).toBe('typesafe');
    expect(config?.decisions?.defaultProvider).toBe('typesafe');
  });

  it('warns and skips when the decision provider has no credentials', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_DECISION_PROVIDER: 'typesafe',
    });

    expect(config?.decisions).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AI_TYPESAFE_API_KEY'));
    warn.mockRestore();
  });

  it('warns and skips when the decision provider is not a decision provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadMultiProviderConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_OPENAI_API_KEY: 'sk-test',
      AI_DECISION_PROVIDER: 'openai',
    });

    expect(config?.decisions).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a decision provider'));
    warn.mockRestore();
  });
});

describe('loadDecisionOverrides', () => {
  it('reads DECISION_{NAME}_PROVIDER and _MODEL', () => {
    expect(
      loadDecisionOverrides({
        DECISION_SUPPORT_TRIAGE_MODEL: 'jev-1.13.0',
        DECISION_SUPPORT_TRIAGE_PROVIDER: 'typesafe',
      }),
    ).toEqual({
      support_triage: { provider: 'typesafe', model: 'jev-1.13.0' },
    });
  });

  it('returns undefined when no overrides are set', () => {
    expect(loadDecisionOverrides({ AI_DEFAULT_PROVIDER: 'openai' })).toBeUndefined();
  });
});
