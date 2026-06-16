import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { createProviderRegistry } from '../../providers/registry.js';
import {
  createVoiceAgentEntry,
  getVoiceAgentRuntimeConfig,
} from '../livekit-agent-worker.js';

describe('createVoiceAgentEntry', () => {
  it('wires voice, providers, and dependencies into runtime config', () => {
    const registry = createProviderRegistry();
    const voice = defineVoice({
      name: 'dvora',
      access: { roles: ['user'] },
      transport: { provider: 'livekit', mode: 'continuous', audioFormat: 'pcm16;rate=16000;channels=1' },
      stt: { provider: 'soniox', languages: ['he'], options: { contextTerms: ['Dvora'] } },
      tts: { provider: 'deepdub', voiceId: 'voice-1', locale: 'he-IL' },
      brain: { async run() { return { text: 'ok' }; } },
    });
    const providers = {
      providers: {
        livekit: {
          url: 'wss://livekit.example.test',
          apiKey: 'lk-key',
          apiSecret: 'lk-secret',
        },
        soniox: { apiKey: 'soniox-key' },
        deepdub: { apiKey: 'deepdub-key' },
      },
    };
    const createDependencies = () => createTestContext();

    const entry = createVoiceAgentEntry({
      voice,
      providers,
      createDependencies,
      registry,
      sessionBudget: { maxUsd: 1 },
    });

    expect(entry).toBeDefined();
    const runtime = getVoiceAgentRuntimeConfig();
    expect(runtime.voice).toBe(voice);
    expect(runtime.providers).toBe(providers);
    expect(runtime.createDependencies).toBe(createDependencies);
    expect(runtime.registry).toBe(registry);
    expect(runtime.sessionBudget).toEqual({ maxUsd: 1 });
  });
});
