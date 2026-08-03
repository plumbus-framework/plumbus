import { describe, expect, it } from 'vitest';
import {
  OPENAI_DEFAULT_BASE_URL,
  resolveOpenAIBaseURL,
  resolveOpenAIClientFactory,
} from '../openai-client.js';

describe('openai client helpers', () => {
  it('omits baseURL when credentials.baseUrl is unset (SDK default)', () => {
    expect(resolveOpenAIBaseURL({ apiKey: 'k' })).toBeUndefined();
  });

  it('strips trailing slashes from custom OpenAI-compatible base URLs', () => {
    expect(resolveOpenAIBaseURL({ apiKey: 'k', baseUrl: 'https://sidecar.local/v1/' })).toBe(
      'https://sidecar.local/v1',
    );
  });

  it('uses injected openaiClientFactory when provided', () => {
    const factory = () =>
      ({
        audio: {
          transcriptions: { create: async () => ({ text: '' }) },
          speech: { create: async () => new Response() },
        },
      }) as const;
    const resolved = resolveOpenAIClientFactory({
      apiKey: 'k',
      options: { openaiClientFactory: factory },
    });
    expect(resolved).toBe(factory);
  });

  it('documents the default REST base constant', () => {
    expect(OPENAI_DEFAULT_BASE_URL).toBe('https://api.openai.com/v1');
  });
});
