import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import type { STTProviderTranscriptEvent } from '../../providers/base/stt-provider.js';
import type { VoiceEvent } from '../../types/event.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

interface Harness {
  controller: VoiceSessionController;
  brainTranscripts: string[];
  sttFinals: string[];
  emit: (event: STTProviderTranscriptEvent) => Promise<void>;
  endpoint: () => Promise<void>;
}

async function makeServerSttHarness(endpointSilenceMs = 10_000): Promise<Harness> {
  const brainTranscripts: string[] = [];
  const sttFinals: string[] = [];
  let onTranscript: ((event: STTProviderTranscriptEvent) => Promise<void>) | undefined;
  let onEndpoint: (() => Promise<void>) | undefined;

  const voice = defineVoice({
    name: 'endpointVoice',
    access: {},
    transport: { provider: 'livekit', mode: 'continuous' },
    stt: { provider: 'mock-stt', options: { endpointSilenceMs } },
    tts: { provider: 'mock-tts' },
    brain: {
      async run(_ctx, args) {
        brainTranscripts.push(args.transcript ?? '');
        return { text: 'reply' };
      },
    },
  });

  const sttProvider = createMockSTTProvider({
    connect(args) {
      onTranscript = args.onTranscript;
      onEndpoint = args.onEndpoint;
    },
  });

  const controller = new VoiceSessionController({
    voice,
    sessionId: 'endpoint-turn',
    ctx: createTestContext(),
    sttProvider,
    ttsProvider: createMockTTSProvider(),
    transportProvider: createMockTransportProvider(),
    onEvent: async (event: VoiceEvent) => {
      if (event.type === 'stt.final') {
        sttFinals.push(event.text);
      }
    },
  });

  await controller.hello();

  return {
    controller,
    brainTranscripts,
    sttFinals,
    emit: async (event) => {
      await onTranscript?.(event);
    },
    endpoint: async () => {
      await onEndpoint?.();
    },
  };
}

describe('VoiceSessionController server STT endpoint wiring', () => {
  it('does not trigger on partials/finals; onEndpoint fires one turn per utterance', async () => {
    const h = await makeServerSttHarness();

    await h.emit({ text: 'שלום', final: false });
    await h.emit({ text: 'שלום עולם', final: true });
    expect(h.controller.turnCount).toBe(0);

    await h.endpoint();
    expect(h.controller.turnCount).toBe(1);
    expect(h.brainTranscripts).toEqual(['שלום עולם']);

    // Second utterance: the SDK provider emits fresh text after the reset.
    await h.emit({ text: 'מה שלומך', final: true });
    expect(h.controller.turnCount).toBe(1);

    await h.endpoint();
    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts[1]).toBe('מה שלומך');
  });

  it('fires a turn on the silence failsafe when no endpoint arrives', async () => {
    const h = await makeServerSttHarness(30);

    await h.emit({ text: 'מה', final: false });
    await h.emit({ text: 'מה שלומך', final: false });
    expect(h.controller.turnCount).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(h.controller.turnCount).toBe(1);
    expect(h.brainTranscripts).toEqual(['מה שלומך']);
  });

  it('defensively strips any leaked <end>/<fin> markers before the brain/chat', async () => {
    const h = await makeServerSttHarness();

    await h.emit({ text: 'שלום עולם<end>', final: true });
    await h.endpoint();

    expect(h.brainTranscripts).toEqual(['שלום עולם']);
    expect(h.sttFinals.join('|')).not.toContain('<end>');
  });
});
