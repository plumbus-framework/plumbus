import { describe, expect, it } from 'vitest';
import { resolveVoiceOpenAICredentials } from '../credentials.js';

describe('resolveVoiceOpenAICredentials', () => {
  it('prefers aiProviders.openai when present', () => {
    const creds = resolveVoiceOpenAICredentials({
      aiProviders: {
        defaultProvider: 'openai',
        providers: {
          openai: {
            provider: 'openai',
            apiKey: 'multi-key',
            baseUrl: 'https://api.openai.test/v1',
            model: 'gpt-4o-mini',
          },
        },
      },
    });

    expect(creds).toEqual({
      apiKey: 'multi-key',
      baseUrl: 'https://api.openai.test/v1',
      options: { model: 'gpt-4o-mini' },
    });
  });

  it('falls back to legacy ai config', () => {
    const creds = resolveVoiceOpenAICredentials({
      ai: {
        provider: 'openai',
        apiKey: 'legacy-key',
        baseUrl: 'https://legacy.openai.test/v1',
      },
    });

    expect(creds?.apiKey).toBe('legacy-key');
  });
});
