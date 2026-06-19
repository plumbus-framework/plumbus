import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';

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
  startVoiceAgentWorker,
} from '../livekit-agent-worker.js';

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
  });

  afterEach(() => {
    resetLiveKitAgentLoggerForTests();
  });

  it('initializes the LiveKit logger before constructing AgentServer', async () => {
    const handle = await startVoiceAgentWorker({
      voices: [voice],
      providers,
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

  it('ensureLiveKitAgentLogger is idempotent', () => {
    ensureLiveKitAgentLogger();
    ensureLiveKitAgentLogger();
    expect(mocks.initializeLogger).toHaveBeenCalledTimes(1);
  });
});
