import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';
import type { STTProviderConnectArgs } from '../../providers/base/stt-provider.js';
import type { VoiceEvent } from '../../types/event.js';

async function harness() {
  let callbacks: STTProviderConnectArgs | undefined;
  const run = vi.fn(async () => ({ text: 'reply' }));
  const events: VoiceEvent[] = [];
  const base = createMockSTTProvider({
    connect(args) {
      callbacks = args;
    },
  });
  const voice = defineVoice({
    name: 'recovery',
    access: {},
    transport: { provider: 'mock', mode: 'continuous' },
    stt: { provider: 'mock', options: { endpointTimeoutMs: 20000 } },
    tts: { provider: 'mock' },
    brain: { run },
  });
  const controller = new VoiceSessionController({
    voice,
    sessionId: 'failure',
    ctx: createTestContext(),
    sttProvider: { ...base, capabilities: { ...base.capabilities, endpointDetection: true } },
    ttsProvider: createMockTTSProvider(),
    transportProvider: createMockTransportProvider(),
    onEvent(e) {
      events.push(e);
    },
  });
  await controller.hello();
  return { controller, callbacks, events, run };
}
describe('STT failures preserve provisional speech', () => {
  it('reports provider failure and ignores late endpoints without inventing a final transcript', async () => {
    const h = await harness();
    await h.callbacks?.onTranscript?.({ text: 'unfinished story', final: false });
    await h.callbacks?.onError?.(new Error('SDK timeout'));
    await h.callbacks?.onEndpoint?.();
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'stt.partial', text: 'unfinished story' }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'voice.stt_failed' }),
    );
    expect(h.events.some((e) => e.type === 'stt.final')).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });
  it('recovers a missing endpoint after the configured wait without running the brain', async () => {
    vi.useFakeTimers();
    const h = await harness();
    try {
      await h.callbacks?.onTranscript?.({ text: 'captured partial', final: false });
      await vi.advanceTimersByTimeAsync(19999);
      expect(h.events.some((e) => e.type === 'error')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'voice.stt_incomplete' }),
      );
      expect(h.run).not.toHaveBeenCalled();
      expect(h.events.some((e) => e.type === 'stt.final')).toBe(false);
    } finally {
      await h.controller.dispose();
      vi.useRealTimers();
    }
  });
});
