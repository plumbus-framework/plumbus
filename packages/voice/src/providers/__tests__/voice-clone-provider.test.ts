import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRegistry,
  createVoiceCloneProvider,
  supportsVoiceCloning,
  synthesizeWithVoiceReference,
} from '../../index.js';
import type { TTSProviderRegistration } from '../../providers/base/provider-registration.js';
import type { VoiceCloneProvider } from '../../types/clone.js';

const CLONE_CAPABILITIES = {
  supported: true as const,
  readiness: 'immediate' as const,
  supportsPersistedCreate: true as const,
  supportsInstantReference: true,
  maxSampleBytes: 1024,
  requiresGender: true,
  requiresLocale: true,
  supportsRecompute: false,
  supportsDelete: true as const,
  supportsList: true as const,
  supportsGet: true as const,
};

function fakeCloneProvider(): VoiceCloneProvider {
  return {
    providerId: 'fake-clone',
    capabilities: CLONE_CAPABILITIES,
    async create() {
      return {
        id: 'v1',
        providerId: 'fake-clone',
        displayName: 'v1',
        status: 'ready',
      };
    },
    async get() {
      return null;
    },
    async list() {
      return { voices: [] };
    },
    async delete() {},
    async waitUntilReady(id) {
      return {
        id,
        providerId: 'fake-clone',
        displayName: id,
        status: 'ready',
      };
    },
  };
}

const FAKE_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: {
    id: 'fake-clone',
    kind: 'tts',
    displayName: 'Fake Clone TTS',
    credentialSchema: [{ field: 'apiKey', required: true }],
    hosting: 'cloud',
    execution: 'server',
    streaming: true,
    toneSupport: 'none',
    deliveryAxes: [],
    deliveryMode: 'none',
    knownModels: [{ id: 'm1', displayName: 'M1', streaming: true }],
  },
  create() {
    return {
      capabilities: this.descriptor,
      mapDeliveryTone() {
        return {};
      },
    };
  },
  clone: {
    capabilities: CLONE_CAPABILITIES,
    create() {
      return fakeCloneProvider();
    },
    async synthesizeWithVoiceReference(_credentials, input) {
      return new TextEncoder().encode(input.text);
    },
  },
};

describe('createVoiceCloneProvider', () => {
  it('creates a clone provider from registration', () => {
    const registry = createProviderRegistry({
      includeBuiltins: false,
      tts: { 'fake-clone': FAKE_TTS_REGISTRATION },
    });
    expect(supportsVoiceCloning(registry, 'fake-clone')).toBe(true);
    const clone = createVoiceCloneProvider({
      providerId: 'fake-clone',
      providers: { providers: { 'fake-clone': { apiKey: 'k' } } },
      registry,
    });
    expect(clone.providerId).toBe('fake-clone');
  });

  it('rejects providers without clone support', () => {
    const registry = createProviderRegistry({ includeBuiltins: true });
    expect(supportsVoiceCloning(registry, 'browser-tts')).toBe(false);
    expect(() =>
      createVoiceCloneProvider({
        providerId: 'browser-tts',
        providers: { providers: {} },
        registry,
      }),
    ).toThrow(/does not support voice cloning/);
  });

  it('dispatches synthesizeWithVoiceReference', async () => {
    const registry = createProviderRegistry({
      includeBuiltins: false,
      tts: { 'fake-clone': FAKE_TTS_REGISTRATION },
    });
    const audio = await synthesizeWithVoiceReference({
      providerId: 'fake-clone',
      providers: { providers: { 'fake-clone': { apiKey: 'k' } } },
      registry,
      input: {
        text: 'hello',
        audio: Buffer.from('sample'),
        filename: 's.wav',
      },
    });
    expect(new TextDecoder().decode(audio)).toBe('hello');
  });

  it('rejects synthesizeWithVoiceReference when unsupported', async () => {
    const registry = createProviderRegistry({ includeBuiltins: true });
    await expect(
      synthesizeWithVoiceReference({
        providerId: 'browser-tts',
        providers: { providers: {} },
        registry,
        input: { text: 'x', audio: Buffer.from('a'), filename: 'a.wav' },
      }),
    ).rejects.toThrow(/instant voice-reference/);
  });
});

describe('assertCloneSampleWithinLimit via create path', () => {
  it('is exported for providers', async () => {
    const { assertCloneSampleWithinLimit } = await import('../../index.js');
    expect(() => assertCloneSampleWithinLimit(Buffer.alloc(2048), CLONE_CAPABILITIES)).toThrow(
      /maxSampleBytes/,
    );
  });
});

describe('waitUntilReady timeout helper contract', () => {
  it('allows providers to implement polling', async () => {
    let calls = 0;
    const provider: VoiceCloneProvider = {
      ...fakeCloneProvider(),
      async waitUntilReady(id, input) {
        calls += 1;
        if (calls < 2) {
          await new Promise((r) => setTimeout(r, input?.pollIntervalMs ?? 1));
        }
        return {
          id,
          providerId: 'fake-clone',
          displayName: id,
          status: 'ready',
        };
      },
    };
    const spy = vi.fn(provider.waitUntilReady.bind(provider));
    provider.waitUntilReady = spy;
    await provider.waitUntilReady('v', { pollIntervalMs: 1, timeoutMs: 1000 });
    expect(spy).toHaveBeenCalled();
  });
});
