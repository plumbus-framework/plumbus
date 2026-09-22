import { EventEmitter } from 'node:events';
import type { JobContext } from '@livekit/agents';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { createProviderRegistry, defineVoice, type VoiceSttConfig } from '@plumbus/voice';
import { createMockSTTProvider, createMockTTSProvider } from '@plumbus/voice/testing';
import { describe, expect, it, vi } from 'vitest';
import * as livekitTransportCost from '../cost/record-livekit-transport.js';
import {
  createVoiceAgentEntry,
  resetVoiceAgentConfigsForTests,
  resolveVoiceAgentConfig,
  startVoiceAgentWorker,
} from '../runtime/livekit-agent-worker.js';
import {
  buildBrainInputFromParticipantContext,
  parseLiveKitParticipantContext,
} from '../runtime/parse-participant-context.js';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '../transport/livekit-transport.js';
import { createTestAgentRegistry } from './fixtures/seed-cloud-addons.js';

describe('createVoiceAgentEntry', () => {
  it('returns an agent definition bound to the supplied voice config', () => {
    const registry = createProviderRegistry({
      transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
    });
    const voice = defineVoice({
      name: 'assistant',
      access: { roles: ['user'] },
      transport: {
        provider: 'livekit',
        mode: 'continuous',
        audioFormat: 'pcm16;rate=16000;channels=1',
      },
      stt: {
        provider: 'soniox',
        languages: ['he'],
        options: { contextTerms: ['Acme'] },
      },
      tts: { provider: 'deepdub', voiceId: 'voice-1', locale: 'he-IL' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
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
    expect(entry.entry).toBeTypeOf('function');
  });

  it('connects to the room before waiting for a participant', async () => {
    const events: string[] = [];
    let capturedSttSlice: VoiceSttConfig | undefined;
    const registry = createProviderRegistry({
      includeBuiltins: false,
      transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
      stt: {
        'mock-stt': {
          descriptor: {
            ...createMockSTTProvider().capabilities,
            knownModels: [],
          },
          create(_credentials, voiceSlice) {
            capturedSttSlice = voiceSlice;
            return createMockSTTProvider();
          },
        },
      },
      tts: {
        'mock-tts': createMockTTSProvider(),
      },
    });
    const voice = defineVoice({
      name: 'assistant',
      access: { roles: ['user'] },
      transport: {
        provider: 'livekit',
        mode: 'continuous',
        audioFormat: 'pcm16;rate=16000;channels=1',
      },
      stt: { provider: 'mock-stt', languages: ['he', 'en'] },
      tts: { provider: 'mock-tts', voiceId: 'voice-1', locale: 'he-IL' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });
    let connected = false;
    const room = new EventEmitter() as EventEmitter & {
      name?: string;
      localParticipant?: { publishData: () => Promise<void> };
    };
    room.name = 'room-session-1';
    room.localParticipant = { publishData: async () => {} };
    const ctx = {
      room,
      async connect() {
        events.push('connect');
        connected = true;
      },
      async waitForParticipant() {
        events.push('waitForParticipant');
        if (!connected) {
          throw new Error('room is not connected');
        }
        return {
          identity: 'user-42',
          metadata: JSON.stringify({
            projectId: 'proj-9',
            sessionId: 'room-session-1',
            language: 'he',
          }),
          attributes: { tenantId: 'tenant-9' },
        };
      },
      addShutdownCallback() {},
    } as unknown as JobContext;
    const entry = createVoiceAgentEntry({
      voice,
      providers: { providers: {} },
      createDependencies: () => createTestContext(),
      registry,
    });

    await entry.entry(ctx);

    expect(events.slice(0, 2)).toEqual(['connect', 'waitForParticipant']);
    expect(capturedSttSlice?.languages).toEqual(['he']);
    expect(capturedSttSlice?.options?.languageHintsStrict).toBeUndefined();
  });

  it('records LiveKit transport cost on shutdown when projectId is present', async () => {
    const recordTransport = vi
      .spyOn(livekitTransportCost, 'recordLiveKitTransportCost')
      .mockResolvedValue(undefined);
    let shutdownCallback: (() => Promise<void>) | undefined;

    const registry = createProviderRegistry({
      includeBuiltins: false,
      transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
      stt: {
        'mock-stt': createMockSTTProvider(),
      },
      tts: {
        'mock-tts': createMockTTSProvider(),
      },
    });
    const voice = defineVoice({
      name: 'assistant',
      access: { roles: ['user'] },
      transport: {
        provider: 'livekit',
        mode: 'continuous',
        audioFormat: 'pcm16;rate=16000;channels=1',
      },
      stt: { provider: 'mock-stt', languages: ['he'] },
      tts: { provider: 'mock-tts', voiceId: 'voice-1' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });
    const room = new EventEmitter() as EventEmitter & {
      name?: string;
      localParticipant?: { publishData: () => Promise<void> };
    };
    room.name = 'room-session-1';
    room.localParticipant = { publishData: async () => {} };
    const ctx = {
      room,
      async connect() {},
      async waitForParticipant() {
        return {
          identity: 'user-42',
          metadata: JSON.stringify({
            projectId: 'proj-9',
            sessionId: 'room-session-1',
          }),
        };
      },
      addShutdownCallback(callback: () => Promise<void>) {
        shutdownCallback = callback;
      },
    } as unknown as JobContext;
    const entry = createVoiceAgentEntry({
      voice,
      providers: { providers: {} },
      createDependencies: () => createTestContext(),
      registry,
    });

    await entry.entry(ctx);
    expect(shutdownCallback).toBeTypeOf('function');
    await shutdownCallback?.();

    expect(recordTransport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'room-session-1',
        costContext: expect.objectContaining({ projectId: 'proj-9' }),
      }),
    );
    recordTransport.mockRestore();
  });
});

describe('startVoiceAgentWorker', () => {
  const providers = {
    providers: {
      livekit: {
        url: 'wss://livekit.example.test',
        apiKey: 'lk-key',
        apiSecret: 'lk-secret',
      },
      soniox: { apiKey: 'soniox-key' },
      deepdub: { apiKey: 'deepdub-key' },
      openai: { apiKey: 'openai-key' },
    },
  };

  it('throws a structured error when no livekit voice exists', async () => {
    const websocketVoice = defineVoice({
      name: 'text-only',
      access: { roles: ['user'] },
      transport: { provider: 'websocket', mode: 'pushToTalk' },
      stt: { provider: 'openai-realtime', languages: ['en'] },
      tts: { provider: 'openai', voiceId: 'alloy' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    await expect(
      startVoiceAgentWorker({
        voices: [websocketVoice],
        providers,
        createDependencies: () => createTestContext(),
      }),
    ).rejects.toBeInstanceOf(PlumbusError);

    await expect(
      startVoiceAgentWorker({
        voices: [websocketVoice],
        providers,
        createDependencies: () => createTestContext(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Validation });
  });

  it('binds separate agent entries for multiple livekit voices', () => {
    const first = defineVoice({
      name: 'alpha',
      access: { roles: ['user'] },
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'soniox', languages: ['en'] },
      tts: { provider: 'deepdub', voiceId: 'voice-1' },
      brain: {
        async run() {
          return { text: 'alpha' };
        },
      },
    });
    const second = defineVoice({
      name: 'beta',
      access: { roles: ['user'] },
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'soniox', languages: ['en'] },
      tts: { provider: 'deepdub', voiceId: 'voice-2' },
      brain: {
        async run() {
          return { text: 'beta' };
        },
      },
    });

    const registry = createTestAgentRegistry();
    const alphaEntry = createVoiceAgentEntry({
      voice: first,
      providers,
      createDependencies: () => createTestContext(),
      registry,
    });
    const betaEntry = createVoiceAgentEntry({
      voice: second,
      providers,
      createDependencies: () => createTestContext(),
      registry,
    });

    expect(alphaEntry.entry).not.toBe(betaEntry.entry);
  });

  it('maps dispatched participant metadata into brain input keys', () => {
    const context = parseLiveKitParticipantContext({
      roomName: 'room-session-1',
      participantIdentity: 'user-42',
      participantMetadata: JSON.stringify({
        projectId: 'proj-9',
        sessionId: 'room-session-1',
        language: 'he',
      }),
      participantAttributes: { tenantId: 'tenant-9' },
    });
    expect(buildBrainInputFromParticipantContext(context)).toEqual({
      sessionId: 'room-session-1',
      projectId: 'proj-9',
      language: 'he',
    });
  });

  it('resolveVoiceAgentConfig selects a named agent when multiple voices are registered', () => {
    resetVoiceAgentConfigsForTests();
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
    const makeVoice = (name: string) =>
      defineVoice({
        name,
        access: { roles: ['user'] },
        transport: { provider: 'livekit', mode: 'continuous' },
        stt: { provider: 'soniox', languages: ['en'] },
        tts: { provider: 'deepdub', voiceId: 'voice-1' },
        brain: {
          async run() {
            return { text: name };
          },
        },
      });

    const registry = createTestAgentRegistry();
    createVoiceAgentEntry({
      voice: makeVoice('alpha'),
      providers,
      createDependencies: () => createTestContext(),
      registry,
    });
    createVoiceAgentEntry({
      voice: makeVoice('beta'),
      providers,
      createDependencies: () => createTestContext(),
      registry,
    });

    expect(resolveVoiceAgentConfig('beta').voice.name).toBe('beta');
    resetVoiceAgentConfigsForTests();
  });
});
