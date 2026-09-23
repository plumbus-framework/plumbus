import { createTestContext } from '@plumbus/core/testing';
import { expect, it, vi } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import { runVoiceTurn } from '../run-turn.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

function setup(
  resolveSttContext: NonNullable<Parameters<typeof defineVoice>[0]['resolveSttContext']>,
) {
  const connect = vi.fn(async () => {});
  const voice = defineVoice({
    name: 'test',
    access: {},
    transport: { provider: 'mock', mode: 'continuous' },
    stt: { provider: 'mock' },
    tts: { provider: 'mock' },
    brain: { run: async () => 'reply' },
    resolveSttContext,
  });
  const ctx = createTestContext();
  const sttProvider = createMockSTTProvider({ connect });
  const ttsProvider = createMockTTSProvider();
  const transportProvider = createMockTransportProvider();
  const controller = new VoiceSessionController({
    voice,
    sessionId: 's',
    ctx,
    sttProvider,
    ttsProvider,
    transportProvider,
    brainInput: { projectId: 'p', language: 'he' },
    onEvent: () => {},
  });
  return { voice, ctx, sttProvider, ttsProvider, transportProvider, controller, connect };
}
it('resolves authenticated context once before connecting, even for overlapping hello calls', async () => {
  const resolve = vi.fn(async () => ({
    general: [{ key: 'topic', value: 'Childhood' }],
    terms: ['Haifa'],
  }));
  const h = setup(resolve);
  await Promise.all([h.controller.hello(), h.controller.hello()]);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(h.ctx, {
    sessionId: 's',
    input: { projectId: 'p', language: 'he' },
    language: 'he',
  });
  expect(h.connect).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      context: { general: [{ key: 'topic', value: 'Childhood' }], terms: ['Haifa'] },
    }),
  );
  await h.controller.dispose();
});
it('rejects oversized context and propagates authorization failures before provider connection', async () => {
  const h = setup(async () => ({ terms: ['x'.repeat(161)] }));
  await expect(h.controller.hello()).rejects.toThrow('Invalid recognition context');
  expect(h.connect).not.toHaveBeenCalled();
  await h.controller.dispose();
  const denied = setup(async () => {
    throw new Error('access denied');
  });
  await expect(denied.controller.hello()).rejects.toThrow('access denied');
  expect(denied.connect).not.toHaveBeenCalled();
  await denied.controller.dispose();
});
it('does not resolve context again for an already transcribed continuous turn', async () => {
  const resolve = vi.fn(async () => ({ terms: ['Haifa'] }));
  const h = setup(resolve);
  for await (const _event of runVoiceTurn(h.ctx, {
    voiceDefinition: h.voice,
    sessionId: 's',
    transcript: 'Hello',
    sttProvider: h.sttProvider,
    ttsProvider: h.ttsProvider,
    transportProvider: h.transportProvider,
  })) {
    /* drain */
  }
  expect(resolve).not.toHaveBeenCalled();
  expect(h.connect).not.toHaveBeenCalled();
  await h.controller.dispose();
});
