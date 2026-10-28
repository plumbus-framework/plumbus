import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapVoiceAgentConfigsFromModule,
  PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV,
  PLUMBUS_VOICE_IDLE_PROCESSES_ENV,
  PLUMBUS_VOICE_PROCESS_INIT_TIMEOUT_MS_ENV,
  prewarmVoiceAgentProcess,
  resetVoiceAgentConfigsForTests,
  resolveVoiceAgentConfig,
  resolveVoiceAgentProcessPoolOptions,
} from '../runtime/livekit-agent-worker.js';

const fixtureBootstrapModule = fileURLToPath(
  new URL('./fixtures/test-voice-agent-bootstrap.ts', import.meta.url),
);

afterEach(() => {
  resetVoiceAgentConfigsForTests();
  vi.unstubAllEnvs();
});

describe('bootstrapVoiceAgentConfigsFromModule', () => {
  it('registers livekit voices when the in-memory map is empty', async () => {
    vi.stubEnv(PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV, fixtureBootstrapModule);

    await bootstrapVoiceAgentConfigsFromModule();

    expect(resolveVoiceAgentConfig('interviewer').voice.name).toBe('interviewer');
    expect(resolveVoiceAgentConfig('interviewer').registry.stt.has('soniox')).toBe(true);
    expect(resolveVoiceAgentConfig('interviewer').registry.transport.has('livekit')).toBe(true);
  });

  it('throws when bootstrap module env is missing', async () => {
    delete process.env[PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV];
    await expect(bootstrapVoiceAgentConfigsFromModule()).rejects.toMatchObject({
      code: 'dependencyViolation',
    });
  });
});

describe('prewarmVoiceAgentProcess', () => {
  it('loads the voice runtime before a job arrives', async () => {
    vi.stubEnv(PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV, fixtureBootstrapModule);

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await prewarmVoiceAgentProcess();

    expect(resolveVoiceAgentConfig('interviewer').voice.name).toBe('interviewer');
    expect(info).toHaveBeenCalledWith('[voice-agent] prewarmed voice runtime', {
      ms: expect.any(Number),
    });
    info.mockRestore();
  });

  it('does nothing without a bootstrap module (in-process worker)', async () => {
    delete process.env[PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV];
    await expect(prewarmVoiceAgentProcess()).resolves.toBeUndefined();
  });

  it('leaves a failed bootstrap for the job entry to retry and report', async () => {
    vi.stubEnv(PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV, '/nonexistent/voice-bootstrap.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(prewarmVoiceAgentProcess()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[voice-agent] prewarm bootstrap failed; retrying at job start',
      expect.objectContaining({ error: expect.any(String) }),
    );
    warn.mockRestore();
    await expect(bootstrapVoiceAgentConfigsFromModule()).rejects.toThrow();
  });
});

describe('resolveVoiceAgentProcessPoolOptions', () => {
  it('keeps the SDK idle-process default and a 30 s start timeout when nothing is set', () => {
    vi.stubEnv(PLUMBUS_VOICE_IDLE_PROCESSES_ENV, '');
    vi.stubEnv(PLUMBUS_VOICE_PROCESS_INIT_TIMEOUT_MS_ENV, '');
    expect(resolveVoiceAgentProcessPoolOptions({})).toEqual({ initializeProcessTimeout: 30_000 });
  });

  it('reads both settings from the environment', () => {
    vi.stubEnv(PLUMBUS_VOICE_IDLE_PROCESSES_ENV, '2');
    vi.stubEnv(PLUMBUS_VOICE_PROCESS_INIT_TIMEOUT_MS_ENV, '45000');
    expect(resolveVoiceAgentProcessPoolOptions({})).toEqual({
      numIdleProcesses: 2,
      initializeProcessTimeout: 45_000,
    });
  });

  it('prefers explicit options over the environment', () => {
    vi.stubEnv(PLUMBUS_VOICE_IDLE_PROCESSES_ENV, '2');
    expect(
      resolveVoiceAgentProcessPoolOptions({
        numIdleProcesses: 0,
        initializeProcessTimeoutMs: 5_000,
      }),
    ).toEqual({ numIdleProcesses: 0, initializeProcessTimeout: 5_000 });
  });

  it('rejects a value that is not a non-negative integer', () => {
    vi.stubEnv(PLUMBUS_VOICE_IDLE_PROCESSES_ENV, 'two');
    expect(() => resolveVoiceAgentProcessPoolOptions({})).toThrow(PLUMBUS_VOICE_IDLE_PROCESSES_ENV);
  });
});
