import { describe, expect, it, vi } from 'vitest';
import {
  fetchVoiceProviderOptions,
  listVoiceProviderCatalog,
  suggestVoiceStacks,
} from '../../index.js';
import type { VoiceCatalogFetch } from '../../providers/base/provider-registration.js';
import { fakeTtsRegistration } from '../../providers/__tests__/fake-registrations.js';
import { createProviderRegistry } from '../../providers/registry.js';

describe('voice catalog smoke', () => {
  it('lists the built-in catalog and suggested stacks', () => {
    const catalog = listVoiceProviderCatalog();
    const stacks = suggestVoiceStacks();

    expect(catalog.transport.map((provider) => provider.id)).toEqual(['websocket']);
    expect(catalog.stt.map((provider) => provider.id)).toEqual(['web-speech']);
    expect(catalog.tts.map((provider) => provider.id)).toEqual(['browser-tts']);
    expect(stacks.map((stack) => stack.id)).toEqual(
      expect.arrayContaining(['fully-local-browser', 'browser-dev']),
    );
    expect(stacks.map((stack) => stack.id)).not.toContain('english-dev');
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

    const registry = createProviderRegistry({
      tts: { deepdub: fakeTtsRegistration('deepdub') },
    });
    const first = await fetchVoiceProviderOptions({
      kind: 'tts',
      providerId: 'deepdub',
      providers,
      registry,
      fetcher,
      ttlMs: 60_000,
    });
    const second = await fetchVoiceProviderOptions({
      kind: 'tts',
      providerId: 'deepdub',
      providers,
      registry,
      fetcher,
      ttlMs: 60_000,
    });

    expect(first.source).toBe('live-api');
    expect(first.partial).toBe(false);
    expect(first.voices.map((voice) => voice.id)).toEqual(['atlas', 'eden']);
    expect(second.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns knownModels from a registered add-on TTS descriptor', async () => {
    const registry = createProviderRegistry({
      tts: {
        custom: fakeTtsRegistration('custom', {
          id: 'custom',
          kind: 'tts',
          displayName: 'Custom',
          credentialSchema: [{ field: 'apiKey', required: true }],
          hosting: 'cloud',
          execution: 'server',
          streaming: true,
          toneSupport: 'none',
          deliveryAxes: [],
          deliveryMode: 'none',
          hebrewQuality: 'unknown',
          knownModels: [
            { id: 'model-a', displayName: 'A', streaming: true, costModelKey: 'model-a' },
          ],
          knownVoices: [],
          voicesSource: 'static',
        }),
      },
    });

    const result = await fetchVoiceProviderOptions({
      kind: 'tts',
      providerId: 'custom',
      providers: {
        providers: {
          custom: { apiKey: 'key' },
        },
      },
      registry,
      ttlMs: 0,
    });

    expect(result.models.map((model) => model.id)).toEqual(['model-a']);
  });
});
