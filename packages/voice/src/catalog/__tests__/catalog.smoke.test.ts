import { describe, expect, it, vi } from 'vitest';
import {
  fetchVoiceProviderOptions,
  listVoiceProviderCatalog,
  suggestVoiceStacks,
} from '../../index.js';
import type { VoiceCatalogFetch } from '../../providers/base/provider-registration.js';

describe('voice catalog smoke', () => {
  it('lists the built-in catalog and suggested stacks', () => {
    const catalog = listVoiceProviderCatalog();
    const stacks = suggestVoiceStacks();

    expect(catalog.transport.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['livekit', 'websocket']),
    );
    expect(catalog.stt.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['soniox', 'openai-whisper', 'openai-realtime', 'web-speech']),
    );
    expect(catalog.tts.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['deepdub', 'openai', 'minimax', 'elevenlabs', 'browser-tts']),
    );
    expect(stacks.map((stack) => stack.id)).toEqual(
      expect.arrayContaining(['hebrew-production', 'fully-local-browser']),
    );
  });

  it('fetches live TTS voice options with cache-backed fixture responses', async () => {
    const fetcher = vi.fn<VoiceCatalogFetch>().mockImplementation(async (url) => {
      if (url.includes('deepdub')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              voices: [
                { id: 'atlas', displayName: 'Atlas', locale: 'he-IL' },
                { id: 'eden', displayName: 'Eden', locale: 'en-US' },
              ],
            };
          },
        };
      }

      return {
        ok: false,
        status: 404,
        async json() {
          return {};
        },
      };
    });

    const providers = {
      providers: {
        deepdub: { apiKey: 'deepdub-key', baseUrl: 'https://api.deepdub.test' },
      },
    };

    const first = await fetchVoiceProviderOptions({
      kind: 'tts',
      providerId: 'deepdub',
      providers,
      fetcher,
      ttlMs: 60_000,
    });
    const second = await fetchVoiceProviderOptions({
      kind: 'tts',
      providerId: 'deepdub',
      providers,
      fetcher,
      ttlMs: 60_000,
    });

    expect(first.source).toBe('live-api');
    expect(first.partial).toBe(false);
    expect(first.voices.map((voice) => voice.id)).toEqual(['atlas', 'eden']);
    expect(second.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to static catalog data when live fetch fails', async () => {
    const result = await fetchVoiceProviderOptions({
      kind: 'tts',
      providerId: 'elevenlabs',
      providers: {
        providers: {
          elevenlabs: { apiKey: 'elevenlabs-key', baseUrl: 'https://api.elevenlabs.test' },
        },
      },
      fetcher: vi.fn(async () => {
        throw new Error('fixture upstream failure');
      }),
      ttlMs: 0,
    });

    expect(result.partial).toBe(true);
    expect(result.source).toBe('live-api');
    expect(result.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['eleven_flash_v2_5', 'eleven_v3']),
    );
    expect(result.error).toContain('fixture upstream failure');
  });
});
