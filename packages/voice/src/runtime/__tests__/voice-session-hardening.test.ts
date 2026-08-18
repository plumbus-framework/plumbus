import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import type { STTProviderTranscriptEvent } from '../../providers/base/stt-provider.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodePcm16(samples: number[]): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, Math.round((samples[index] ?? 0) * 32_767), true);
  }
  return output;
}

interface HardeningHarness {
  controller: VoiceSessionController;
  brainTranscripts: string[];
  ttsTexts: string[];
  releaseTurn: () => Promise<void>;
  blockNextTurn: () => void;
  emit: (event: STTProviderTranscriptEvent) => Promise<void>;
  endpoint: () => Promise<void>;
}

async function makeHardeningHarness(
  opts: {
    endpointGraceMs?: number;
    endpointDetection?: boolean;
    endpointSilenceMs?: number;
    enableInputNormalization?: boolean;
    ttsFailOnce?: boolean;
  } = {},
): Promise<HardeningHarness> {
  const brainTranscripts: string[] = [];
  const ttsTexts: string[] = [];
  let onTranscript: ((event: STTProviderTranscriptEvent) => Promise<void>) | undefined;
  let onEndpoint: (() => Promise<void>) | undefined;
  let blockNext = false;
  let release: (() => void) | undefined;
  let failNextTts = opts.ttsFailOnce === true;

  const sttOptions: Record<string, unknown> = { endpointSilenceMs: opts.endpointSilenceMs ?? 0 };
  if (typeof opts.endpointGraceMs === 'number') {
    sttOptions.endpointGraceMs = opts.endpointGraceMs;
  }
  if (opts.enableInputNormalization !== undefined) {
    sttOptions.enableInputNormalization = opts.enableInputNormalization;
  }

  const voice = defineVoice({
    name: 'hardeningVoice',
    access: {},
    transport: { provider: 'livekit', mode: 'continuous', audioFormat: 'pcm16-16k' },
    stt: { provider: 'mock-stt', options: sttOptions },
    tts: { provider: 'mock-tts' },
    brain: {
      async run(_ctx, args) {
        brainTranscripts.push(args.transcript ?? '');
        if (blockNext) {
          blockNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { text: 'reply' };
      },
    },
  });

  const baseProvider = createMockSTTProvider({
    connect(args) {
      onTranscript = args.onTranscript;
      onEndpoint = args.onEndpoint;
    },
  });
  const sttProvider =
    (opts.endpointDetection ?? true)
      ? {
          ...baseProvider,
          capabilities: { ...baseProvider.capabilities, endpointDetection: true },
        }
      : baseProvider;

  const controller = new VoiceSessionController({
    voice,
    sessionId: 'hardening',
    ctx: createTestContext(),
    brainInput: { language: 'he' },
    sttProvider,
    ttsProvider: createMockTTSProvider({
      async *synthesizeStream(text) {
        ttsTexts.push(text);
        if (failNextTts) {
          failNextTts = false;
          throw new Error('tts unavailable');
        }
        yield new Uint8Array([1, 2]);
      },
    }),
    transportProvider: createMockTransportProvider(),
    onEvent: async () => {},
  });

  await controller.hello();

  return {
    controller,
    brainTranscripts,
    ttsTexts,
    releaseTurn: async () => {
      while (!release) {
        await sleep(5);
      }
      release();
      release = undefined;
    },
    blockNextTurn: () => {
      blockNext = true;
    },
    emit: async (event) => {
      await onTranscript?.(event);
    },
    endpoint: async () => {
      await onEndpoint?.();
    },
  };
}

describe('VoiceSessionController teardown hardening', () => {
  it('ignores late transcripts and endpoints after dispose (no ghost turn)', async () => {
    const h = await makeHardeningHarness();

    await h.controller.dispose();
    // A suspended provider chain can deliver both events after teardown.
    await h.emit({ text: 'אחרי סגירה', final: true });
    await h.endpoint();
    await sleep(20);

    expect(h.controller.turnCount).toBe(0);
    expect(h.brainTranscripts).toEqual([]);
  });

  it('transport loss disarms an armed grace timer', async () => {
    const h = await makeHardeningHarness({ endpointGraceMs: 50 });

    await h.emit({ text: 'אבוד', final: true });
    await h.endpoint();
    await h.controller.notifyTransportLost();
    await sleep(120);

    expect(h.controller.turnCount).toBe(0);
    expect(h.brainTranscripts).toEqual([]);
  });

  it('ignores late transcripts and endpoints after transport loss (no ghost turn)', async () => {
    const h = await makeHardeningHarness();

    await h.controller.notifyTransportLost();
    // A suspended provider chain can deliver both events after the socket
    // drop and before dispose() runs (http.ts awaits two onEvent calls first).
    await h.emit({ text: 'אחרי ניתוק', final: true });
    await h.endpoint();
    await sleep(20);

    expect(h.controller.turnCount).toBe(0);
    expect(h.brainTranscripts).toEqual([]);
  });

  it('contains a repair-TTS failure on the grace-timer path (no unhandled rejection)', async () => {
    const h = await makeHardeningHarness({ endpointGraceMs: 50, ttsFailOnce: true });

    // Speech energy + empty transcript endpoint → grace timer → repair, whose
    // TTS throws. Without the timer-path catch this is an unhandled rejection.
    await h.controller.handleAudioChunk(encodePcm16([0.5, -0.5, 0.4, -0.4]));
    await h.endpoint();
    await sleep(150);

    expect(h.ttsTexts.length).toBe(1);
    expect(h.brainTranscripts).toEqual([]);
  });
});

describe('VoiceSessionController barge-in hardening', () => {
  it('replays speech that arrives after a barge-in while the aborted turn unwinds', async () => {
    const h = await makeHardeningHarness();

    h.blockNextTurn();
    await h.emit({ text: 'פתיחה', final: true });
    const firstTurn = h.endpoint();
    // Wait until the brain is actually running so the barge-in aborts a turn
    // mid-flight (the scenario under test), not one that never started.
    while (h.brainTranscripts.length === 0) {
      await sleep(5);
    }

    await h.controller.bargeIn();
    // The user speaks again while the aborted turn is still unwinding.
    await h.emit({ text: 'קטע אחרי העצירה', final: true });
    await h.endpoint();

    await h.releaseTurn();
    await firstTurn.catch(() => {});
    await sleep(20);

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['פתיחה', 'קטע אחרי העצירה']);
  });

  it('cancels a turn waiting in the grace window', async () => {
    const h = await makeHardeningHarness({ endpointGraceMs: 50 });

    await h.emit({ text: 'לבטל', final: true });
    await h.endpoint();
    await h.controller.bargeIn();
    await sleep(120);

    expect(h.controller.turnCount).toBe(0);
    expect(h.brainTranscripts).toEqual([]);

    await h.emit({ text: 'אחרי', final: true });
    await h.endpoint();
    await sleep(120);

    expect(h.controller.turnCount).toBe(1);
    expect(h.brainTranscripts).toEqual(['אחרי']);
  });
});

describe('VoiceSessionController transcript integrity hardening', () => {
  it('an empty stt.final control frame does not clobber a queued transcript', async () => {
    const h = await makeHardeningHarness();

    h.blockNextTurn();
    await h.emit({ text: 'פתיחה', final: true });
    const firstTurn = h.endpoint();

    await h.emit({ text: 'תשובה אמיתית', final: true });
    await h.endpoint();
    await h.controller.handleControlMessage({ type: 'stt.final', text: '' });

    await h.releaseTurn();
    await firstTurn;

    expect(h.brainTranscripts).toEqual(['פתיחה', 'תשובה אמיתית']);
  });

  it('silence-failsafe queueing does not duplicate a still-open cumulative utterance', async () => {
    const h = await makeHardeningHarness({ endpointDetection: false, endpointSilenceMs: 30 });

    h.blockNextTurn();
    await h.emit({ text: 'שלום', final: false });
    await sleep(60);
    expect(h.controller.turnCount).toBe(1);

    await h.emit({ text: 'עוד', final: false });
    await sleep(60); // failsafe fires mid-turn and queues 'עוד'
    // The SAME provider utterance keeps growing (no endpoint ever fired).
    await h.emit({ text: 'עוד קצת', final: false });
    await sleep(60);

    await h.releaseTurn();
    await sleep(80);

    expect(h.brainTranscripts[0]).toBe('שלום');
    expect(h.brainTranscripts[1]).toBe('עוד קצת');
  });
});

describe('VoiceSessionController speech-energy gate', () => {
  // ~-54 dBFS peak: below the -45 dBFS gate raw, above it after normalization.
  const quietFrame = encodePcm16(Array.from({ length: 320 }, (_, i) => (i % 2 ? 0.002 : -0.002)));

  it('quiet speech passes the gate when input normalization is enabled', async () => {
    const h = await makeHardeningHarness({ enableInputNormalization: true });

    await h.controller.handleAudioChunk(quietFrame);
    await h.endpoint();
    await sleep(20);

    // Empty transcript + speech energy → hearing-repair prompt is spoken.
    expect(h.ttsTexts.length).toBe(1);
  });

  it('quiet speech stays below the gate without normalization (control)', async () => {
    const h = await makeHardeningHarness({ enableInputNormalization: false });

    await h.controller.handleAudioChunk(quietFrame);
    await h.endpoint();
    await sleep(20);

    expect(h.ttsTexts).toEqual([]);
  });
});
