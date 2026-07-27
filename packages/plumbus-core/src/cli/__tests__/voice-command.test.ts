import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

  it('CLI loads LiveKit worker APIs from @plumbus/voice-livekit, not @plumbus/voice', async () => {
    const voicePkg = await import('@plumbus/voice');
    expect(typeof (voicePkg as { startVoiceAgentWorker?: unknown }).startVoiceAgentWorker).toBe(
      'undefined',
    );
    expect(typeof (voicePkg as { joinVoiceRoomSession?: unknown }).joinVoiceRoomSession).toBe(
      'undefined',
    );
    expect(typeof (voicePkg as { loadVoiceAddons?: unknown }).loadVoiceAddons).toBe('undefined');
    expect(typeof (voicePkg as { createRegistryForVoices?: unknown }).createRegistryForVoices).toBe(
      'undefined',
    );
    expect(typeof voicePkg.loadAppVoiceRegistry).toBe('function');

    const voiceCommandSource = readFileSync(
      new URL('../commands/voice.ts', import.meta.url),
      'utf8',
    );
    expect(voiceCommandSource).toContain('@plumbus/voice-livekit');
    expect(voiceCommandSource).not.toContain('createRegistryForVoices');
    expect(voiceCommandSource).toContain('startVoiceAgentWorker');
    expect(voiceCommandSource).toContain('joinVoiceRoomSession');
    expect(resolveVoiceWorkerBranch({})).toBe('agent-dispatch');
    expect(resolveVoiceWorkerBranch({ room: 'room-1' })).toBe('join-room');
  }, 15_000);
});
