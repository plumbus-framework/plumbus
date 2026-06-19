import { describe, expect, it } from 'vitest';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { startVoiceWorker, joinVoiceRoomSession } from '../worker.js';
import {
  resolveVoiceAgentConfig,
  resetVoiceAgentConfigsForTests,
  startVoiceAgentWorker,
  createVoiceAgentEntry,
} from '../livekit-agent-worker.js';

describe('voice runtime structured errors', () => {
  it('startVoiceWorker throws PlumbusError when createExecutionContext is missing', async () => {
    const voice = defineVoice({
      name: 'lkVoice',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    await expect(
      startVoiceWorker({
        voices: [voice],
        providers: {
          providers: {
            livekit: {
              url: 'wss://livekit.example.test',
              apiKey: 'lk-key',
              apiSecret: 'lk-secret',
            },
          },
        },
      } as never),
    ).rejects.toBeInstanceOf(PlumbusError);
  });

  it('startVoiceAgentWorker throws PlumbusError when no livekit voice exists', async () => {
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
        providers: {
          providers: {
            livekit: {
              url: 'wss://livekit.example.test',
              apiKey: 'lk-key',
              apiSecret: 'lk-secret',
            },
          },
        },
        createDependencies: () => createTestContext(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Validation });
  });

  it('resolveVoiceAgentConfig throws when multiple voices are registered without agentName', () => {
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

    createVoiceAgentEntry({
      voice: makeVoice('alpha'),
      providers,
      createDependencies: () => createTestContext(),
    });
    createVoiceAgentEntry({
      voice: makeVoice('beta'),
      providers,
      createDependencies: () => createTestContext(),
    });

    expect(() => resolveVoiceAgentConfig(undefined)).toThrow(PlumbusError);
    resetVoiceAgentConfigsForTests();
  });

  it('joinVoiceRoomSession throws PlumbusError for invalid providers', async () => {
    const voice = defineVoice({
      name: 'lkVoice',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'soniox', languages: ['he'] },
      tts: { provider: 'deepdub', voiceId: 'voice-1' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    await expect(
      joinVoiceRoomSession({
        voice,
        providers: { providers: {} },
        roomName: 'room-1',
        createExecutionContext: () => createTestContext(),
      }),
    ).rejects.toBeInstanceOf(PlumbusError);
  });
});
