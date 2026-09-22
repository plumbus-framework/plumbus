import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapVoiceAgentConfigsFromModule,
  PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV,
  resetVoiceAgentConfigsForTests,
  resolveVoiceAgentConfig,
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
