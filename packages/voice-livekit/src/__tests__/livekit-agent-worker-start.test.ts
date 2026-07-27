import { createTestContext } from '@plumbus/core/testing';
import { createSTTProvider, createTTSProvider, defineVoice } from '@plumbus/voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAgentRegistry } from './fixtures/seed-cloud-addons.js';

const mocks = vi.hoisted(() => {
  const initializeLogger = vi.fn();
  const agentServerRun = vi.fn(async () => {});
  const agentServerClose = vi.fn(async () => {});
  const AgentServer = vi.fn(function AgentServerMock(this: {
    run: typeof agentServerRun;
    close: typeof agentServerClose;
  }) {
    this.run = agentServerRun;
    this.close = agentServerClose;
  });
  return { initializeLogger, agentServerRun, agentServerClose, AgentServer };
});

vi.mock('@livekit/agents', async () => {
  const actual = await vi.importActual<typeof import('@livekit/agents')>('@livekit/agents');
  return {
    ...actual,
    initializeLogger: mocks.initializeLogger,
    AgentServer: mocks.AgentServer,
  };
});

import {
  ensureLiveKitAgentLogger,
  resetLiveKitAgentLoggerForTests,
  resetVoiceAgentConfigsForTests,
  resolveVoiceAgentConfig,
  startVoiceAgentWorker,
} from '../runtime/livekit-agent-worker.js';

describe('startVoiceAgentWorker startup', () => {
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

  const voice = defineVoice({
    name: 'interviewer',
    access: { roles: ['user'] },
    transport: { provider: 'livekit', mode: 'continuous' },
    stt: { provider: 'soniox', languages: ['he'] },
    tts: { provider: 'deepdub', voiceId: 'voice-1' },
    brain: {
      async run() {
        return { text: 'ok' };
      },
    },
  });

  beforeEach(() => {
    mocks.initializeLogger.mockClear();
    mocks.AgentServer.mockClear();
    mocks.agentServerRun.mockClear();
    mocks.agentServerClose.mockClear();
    resetLiveKitAgentLoggerForTests();
    resetVoiceAgentConfigsForTests();
  });

  afterEach(() => {
    resetLiveKitAgentLoggerForTests();
    resetVoiceAgentConfigsForTests();
  });

  it('initializes the LiveKit logger before constructing AgentServer', async () => {
    const handle = await startVoiceAgentWorker({
      voices: [voice],
      providers,
      registry: createTestAgentRegistry(),
      createDependencies: () => createTestContext(),
      wsURL: 'wss://livekit.example.test',
      apiKey: 'lk-key',
      apiSecret: 'lk-secret',
    });

    expect(mocks.initializeLogger).toHaveBeenCalledTimes(1);
    expect(mocks.AgentServer).toHaveBeenCalledTimes(1);
    expect(mocks.initializeLogger.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.AgentServer.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    await handle.stop();
    expect(mocks.agentServerClose).toHaveBeenCalledTimes(1);
  });

  it('uses the explicit registry for cloud STT/TTS', async () => {
    const registry = createTestAgentRegistry();
    const handle = await startVoiceAgentWorker({
      voices: [voice],
      providers,
      registry,
      createDependencies: () => createTestContext(),
      wsURL: 'wss://livekit.example.test',
      apiKey: 'lk-key',
      apiSecret: 'lk-secret',
    });

    const resolved = resolveVoiceAgentConfig('interviewer').registry;
    expect(resolved.stt.has('soniox')).toBe(true);
    expect(resolved.tts.has('deepdub')).toBe(true);
    expect(resolved.transport.has('livekit')).toBe(true);

    expect(() =>
      createSTTProvider({
        registry: resolved,
        providers,
        voiceSlice: voice.stt,
      }),
    ).not.toThrow();
    expect(() =>
      createTTSProvider({
        registry: resolved,
        providers,
        voiceSlice: voice.tts,
      }),
    ).not.toThrow();

    await handle.stop();
  });

  it('rejects cloud STT/TTS when they are missing from the explicit registry', async () => {
    await expect(
      startVoiceAgentWorker({
        voices: [voice],
        providers,
        registry: createTestAgentRegistry({ includeCloud: false }),
        createDependencies: () => createTestContext(),
        wsURL: 'wss://livekit.example.test',
        apiKey: 'lk-key',
        apiSecret: 'lk-secret',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('createProviderRegistry'),
    });
  });

  it('rejects an explicit registry that omits transport.livekit', async () => {
    const { createProviderRegistry } = await import('@plumbus/voice');
    const registry = createProviderRegistry({
      includeBuiltins: false,
      stt: Object.fromEntries(createTestAgentRegistry().stt),
      tts: Object.fromEntries(createTestAgentRegistry().tts),
    });

    await expect(
      startVoiceAgentWorker({
        voices: [voice],
        providers,
        registry,
        createDependencies: () => createTestContext(),
        wsURL: 'wss://livekit.example.test',
        apiKey: 'lk-key',
        apiSecret: 'lk-secret',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('transport.livekit'),
    });
  });

  it('ensureLiveKitAgentLogger is idempotent', () => {
    ensureLiveKitAgentLogger();
    ensureLiveKitAgentLogger();
    expect(mocks.initializeLogger).toHaveBeenCalledTimes(1);
  });
});
