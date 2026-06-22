import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureVoiceAgentBootstrapEnv,
  isVoiceWorkerDisabled,
  resolveVoiceAgentBootstrapModulePath,
  resolveVoiceWorkerBranch,
} from '../commands/voice.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('plumbus voice worker command routing', () => {
  it('treats VOICE_AGENT_ENABLED=false as disabled', () => {
    vi.stubEnv('VOICE_AGENT_ENABLED', 'false');
    expect(isVoiceWorkerDisabled()).toBe(true);
  });

  it('uses agent dispatch when room is absent', () => {
    vi.stubEnv('VOICE_AGENT_ROOM', '');
    expect(resolveVoiceWorkerBranch({})).toBe('agent-dispatch');
  });

  it('joins explicit room when --room is set', () => {
    expect(resolveVoiceWorkerBranch({ room: 'session-1' })).toBe('join-room');
  });

  it('prefers --room over VOICE_AGENT_ROOM for join-room branch', () => {
    vi.stubEnv('VOICE_AGENT_ROOM', 'env-room');
    expect(resolveVoiceWorkerBranch({ room: 'cli-room' })).toBe('join-room');
  });

  it('sets PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE for child agent processes', () => {
    delete process.env.PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE;
    ensureVoiceAgentBootstrapEnv();
    expect(process.env.PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE).toBe(
      resolveVoiceAgentBootstrapModulePath(),
    );
  });

  it('emits voice-agent-bootstrap.js in package dist for child-process import', () => {
    const distBootstrap = fileURLToPath(
      new URL('../../../dist/cli/voice-agent-bootstrap.js', import.meta.url),
    );
    expect(existsSync(distBootstrap)).toBe(true);
  });
});
