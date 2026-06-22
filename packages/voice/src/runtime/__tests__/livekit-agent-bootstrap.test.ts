import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  bootstrapVoiceAgentConfigsFromModule,
  PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV,
  resetVoiceAgentConfigsForTests,
  resolveVoiceAgentConfig,
} from '../livekit-agent-worker.js';

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
  });

  it('throws when bootstrap module env is missing', async () => {
    await expect(bootstrapVoiceAgentConfigsFromModule()).rejects.toMatchObject({
      message: expect.stringContaining('bootstrap module is not configured'),
    });
  });
});
