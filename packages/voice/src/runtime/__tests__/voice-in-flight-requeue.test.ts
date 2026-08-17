import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import type { VoiceSessionBudget } from '../../cost/session-budget.js';
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

interface Harness {
  controller: VoiceSessionController;
  brainTranscripts: string[];
  releaseTurn: () => Promise<void>;
  blockNextTurn: () => void;
  emit: (event: STTProviderTranscriptEvent) => Promise<void>;
  endpoint: () => Promise<void>;
}

async function makeRequeueHarness(
  opts: {
    endpointGraceMs?: number;
    endpointDetection?: boolean;
    endpointSilenceMs?: number;
    budget?: VoiceSessionBudget;
  } = {},
): Promise<Harness> {
  const brainTranscripts: string[] = [];
  let onTranscript: ((event: STTProviderTranscriptEvent) => Promise<void>) | undefined;
  let onEndpoint: (() => Promise<void>) | undefined;
  let blockNext = false;
  let release: (() => void) | undefined;

  const sttOptions: Record<string, unknown> = { endpointSilenceMs: opts.endpointSilenceMs ?? 0 };
  if (typeof opts.endpointGraceMs === 'number') {
    sttOptions.endpointGraceMs = opts.endpointGraceMs;
  }

  const voice = defineVoice({
    name: 'requeueVoice',
    access: {},
    transport: { provider: 'livekit', mode: 'continuous' },
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
    sessionId: 'in-flight-requeue',
    ctx: createTestContext(),
    sttProvider,
    ttsProvider: createMockTTSProvider(),
    transportProvider: createMockTransportProvider(),
    budget: opts.budget,
    onEvent: async () => {},
  });

  await controller.hello();

  return {
    controller,
    brainTranscripts,
    releaseTurn: async () => {
      // The brain is reached only after a macrotask boundary in the turn
      // pipeline; wait until the gate is armed before releasing it.
      while (!release) {
        await new Promise((resolve) => setTimeout(resolve, 5));
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

describe('VoiceSessionController in-flight speech re-queue', () => {
  it('re-queues an utterance whose endpoint fires while a turn is in flight', async () => {
    const h = await makeRequeueHarness();

    h.blockNextTurn();
    await h.emit({ text: 'שאלה ראשונה', final: true });
    const firstTurn = h.endpoint();
    expect(h.controller.turnCount).toBe(1);

    // The user answers while the reply is still being generated/spoken.
    await h.emit({ text: 'תשובה באמצע', final: false });
    await h.emit({ text: 'תשובה באמצע הדיבור', final: true });
    await h.endpoint();
    expect(h.controller.turnCount).toBe(1);

    await h.releaseTurn();
    await firstTurn;

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['שאלה ראשונה', 'תשובה באמצע הדיבור']);
  });

  it('stitches multiple utterances queued during one in-flight turn', async () => {
    const h = await makeRequeueHarness();

    h.blockNextTurn();
    await h.emit({ text: 'פתיחה', final: true });
    const firstTurn = h.endpoint();

    await h.emit({ text: 'חלק ראשון', final: true });
    await h.endpoint();
    await h.emit({ text: 'חלק שני', final: true });
    await h.endpoint();

    await h.releaseTurn();
    await firstTurn;

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['פתיחה', 'חלק ראשון חלק שני']);
  });

  it('does not fire an extra turn when nothing arrived mid-turn', async () => {
    const h = await makeRequeueHarness();

    await h.emit({ text: 'שקט אחריי', final: true });
    await h.endpoint();

    expect(h.controller.turnCount).toBe(1);
    expect(h.brainTranscripts).toEqual(['שקט אחריי']);
  });

  it('never replays mid-utterance: resumed speech stitches once via its own endpoint', async () => {
    const h = await makeRequeueHarness({ endpointGraceMs: 50 });

    h.blockNextTurn();
    await h.emit({ text: 'A', final: true });
    await h.endpoint();
    await sleep(80);
    expect(h.controller.turnCount).toBe(1);

    // 'B' endpoints while the reply is in flight; its grace timer fires mid-turn.
    await h.emit({ text: 'B', final: true });
    await h.endpoint();
    await sleep(80);

    // The user resumes: a new cumulative utterance is open when the turn ends.
    await h.emit({ text: 'C', final: false });
    await h.releaseTurn();
    await sleep(30);

    // Replaying here would snapshot the open utterance and duplicate its
    // overlap ('B C C D'); the utterance's own endpoint must deliver 'B C D'.
    await h.emit({ text: 'C D', final: false });
    await h.endpoint();
    await sleep(80);

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['A', 'B C D']);
  });

  it('replays a closed queued utterance through the grace window after the turn', async () => {
    const h = await makeRequeueHarness({ endpointGraceMs: 50 });

    h.blockNextTurn();
    await h.emit({ text: 'A', final: true });
    await h.endpoint();
    await sleep(80);
    expect(h.controller.turnCount).toBe(1);

    await h.emit({ text: 'B', final: true });
    await h.endpoint();
    await sleep(80);
    expect(h.controller.turnCount).toBe(1);

    await h.releaseTurn();
    await sleep(150);

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['A', 'B']);
  });

  it('discards queued speech when the user barges in', async () => {
    const h = await makeRequeueHarness();

    h.blockNextTurn();
    await h.emit({ text: 'פתיחה', final: true });
    const firstTurn = h.endpoint();

    await h.emit({ text: 'נבלע', final: true });
    await h.endpoint();

    await h.controller.bargeIn();
    await h.releaseTurn();
    await firstTurn.catch(() => {});
    await sleep(20);

    expect(h.controller.turnCount).toBe(1);

    await h.emit({ text: 'חדש', final: true });
    await h.endpoint();

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['פתיחה', 'חדש']);
  });

  it('queues speech from the silence failsafe while a turn is in flight', async () => {
    const h = await makeRequeueHarness({ endpointDetection: false, endpointSilenceMs: 30 });

    h.blockNextTurn();
    await h.emit({ text: 'ראשון', final: false });
    await sleep(60);
    expect(h.controller.turnCount).toBe(1);

    await h.emit({ text: 'שני', final: false });
    await sleep(60);
    expect(h.controller.turnCount).toBe(1);

    await h.releaseTurn();
    await sleep(50);

    expect(h.controller.turnCount).toBe(2);
    expect(h.brainTranscripts).toEqual(['ראשון', 'שני']);
  });

  it('records STT budget once per turn including the stitched replay', async () => {
    const records: Array<{ sttCharacters?: number }> = [];
    const budget = {
      config: {},
      state: {},
      check: () => ({ allowed: true }),
      record: (usage: { sttCharacters?: number }) => {
        records.push(usage);
        return {};
      },
    } as unknown as VoiceSessionBudget;
    const h = await makeRequeueHarness({ budget });

    h.blockNextTurn();
    await h.emit({ text: 'פתיחה', final: true });
    const firstTurn = h.endpoint();

    await h.emit({ text: 'חלק ראשון', final: true });
    await h.endpoint();
    await h.emit({ text: 'חלק שני', final: true });
    await h.endpoint();

    await h.releaseTurn();
    await firstTurn;

    const sttRecords = records.filter((r) => typeof r.sttCharacters === 'number');
    expect(sttRecords).toEqual([
      { sttCharacters: 'פתיחה'.length },
      { sttCharacters: 'חלק ראשון חלק שני'.length },
    ]);
  });

  it('keeps the deferred fragment across multiple cumulative partials', async () => {
    const h = await makeRequeueHarness({ endpointGraceMs: 50 });

    await h.emit({ text: 'part one', final: false });
    await h.endpoint();
    // Server STT partials are cumulative per utterance: each event carries the
    // full utterance-so-far, so a second partial must not clobber the deferred
    // pre-pause fragment.
    await h.emit({ text: 'part', final: false });
    await h.emit({ text: 'part two', final: false });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.controller.turnCount).toBe(0);

    await h.endpoint();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.controller.turnCount).toBe(1);
    expect(h.brainTranscripts).toEqual(['part one part two']);
  });
});

describe('VoiceSessionController re-queue during hearing repair', () => {
  function encodePcm16(samples: number[]): Uint8Array {
    const output = new Uint8Array(samples.length * 2);
    const view = new DataView(output.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      view.setInt16(index * 2, Math.round((samples[index] ?? 0) * 32_767), true);
    }
    return output;
  }

  async function makeRepairHarness(opts: { ttsFailAfterRelease?: boolean } = {}) {
    const brainTranscripts: string[] = [];
    const ttsTexts: string[] = [];
    let onTranscript: ((event: STTProviderTranscriptEvent) => Promise<void>) | undefined;
    let onEndpoint: (() => Promise<void>) | undefined;
    let releaseTts: (() => void) | undefined;
    let blockNextTts = false;
    let repairPromise: Promise<void> | undefined;
    let disposeOnNextListening = false;
    let notifyLostOnNextListening = false;
    let controllerRef: VoiceSessionController | undefined;

    const voice = defineVoice({
      name: 'requeueRepairVoice',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous', audioFormat: 'pcm16-16k' },
      stt: { provider: 'mock-stt', options: { endpointSilenceMs: 0 } },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          brainTranscripts.push(args.transcript ?? '');
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
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'repair-requeue',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          if (blockNextTts) {
            blockNextTts = false;
            await new Promise<void>((resolve) => {
              releaseTts = resolve;
            });
            if (opts.ttsFailAfterRelease) {
              throw new Error('tts unavailable');
            }
          }
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async (event) => {
        if (event.type !== 'agent.state' || event.state !== 'Listening') {
          return;
        }
        if (disposeOnNextListening) {
          disposeOnNextListening = false;
          await controllerRef?.dispose();
          return;
        }
        if (notifyLostOnNextListening) {
          notifyLostOnNextListening = false;
          await controllerRef?.notifyTransportLost();
        }
      },
    });
    controllerRef = controller;

    await controller.hello();

    return {
      controller,
      brainTranscripts,
      ttsTexts,
      armDisposeOnNextListening: () => {
        disposeOnNextListening = true;
      },
      armNotifyLostOnNextListening: () => {
        notifyLostOnNextListening = true;
      },
      emit: async (event: STTProviderTranscriptEvent) => {
        await onTranscript?.(event);
      },
      endpoint: async () => {
        await onEndpoint?.();
      },
      // Empty endpoint after speech energy triggers the hearing-repair prompt;
      // the gated TTS keeps the repair in flight. The repair promise is stashed
      // (NOT returned — an async return value would flatten into the pending
      // repair chain and deadlock the caller until the gate is released).
      startRepair: async () => {
        blockNextTts = true;
        await controller.handleAudioChunk(encodePcm16([0.5, -0.5, 0.4, -0.4]));
        repairPromise = (onEndpoint?.() ?? Promise.resolve()).catch(() => {});
        await sleep(0);
      },
      awaitRepair: async () => {
        await repairPromise;
        await sleep(30);
      },
      releaseTts: async () => {
        while (!releaseTts) {
          await sleep(5);
        }
        releaseTts();
        releaseTts = undefined;
      },
    };
  }

  it('replays speech that endpointed while a repair prompt was being spoken', async () => {
    const h = await makeRepairHarness();

    await h.startRepair();
    expect(h.ttsTexts.length).toBe(1);

    await h.emit({ text: 'עכשיו שומעים אותי', final: true });
    await h.endpoint();
    expect(h.brainTranscripts).toEqual([]);

    await h.releaseTts();
    await h.awaitRepair();

    expect(h.brainTranscripts).toEqual(['עכשיו שומעים אותי']);
  });

  it('does not replay queued speech after dispose during a hearing repair', async () => {
    const h = await makeRepairHarness();

    await h.startRepair();
    expect(h.ttsTexts.length).toBe(1);

    await h.emit({ text: 'זומבי', final: true });
    await h.endpoint();

    await h.controller.dispose();
    await h.releaseTts();
    await h.awaitRepair();

    expect(h.brainTranscripts).toEqual([]);
  });

  it('does not replay queued speech when dispose lands during the post-repair state emit', async () => {
    const h = await makeRepairHarness();

    await h.startRepair();
    await h.emit({ text: 'מרוץ', final: true });
    await h.endpoint();

    // Dispose fires from inside the repair finally's own Listening emit —
    // after the queued flag was captured locally, so only the #disposed gate
    // can stop the replay.
    h.armDisposeOnNextListening();
    await h.releaseTts();
    await h.awaitRepair();

    expect(h.brainTranscripts).toEqual([]);
  });

  it('does not replay queued speech after transport loss during a hearing repair', async () => {
    const h = await makeRepairHarness();

    await h.startRepair();
    expect(h.ttsTexts.length).toBe(1);

    await h.emit({ text: 'זומבי ניתוק', final: true });
    await h.endpoint();

    await h.controller.notifyTransportLost();
    await h.releaseTts();
    await h.awaitRepair();

    expect(h.brainTranscripts).toEqual([]);
  });

  it('does not replay queued speech when transport loss lands during the post-repair state emit', async () => {
    const h = await makeRepairHarness();

    await h.startRepair();
    await h.emit({ text: 'מרוץ ניתוק', final: true });
    await h.endpoint();

    // notifyTransportLost fires from inside the repair finally's own Listening
    // emit — after the queued flag was captured locally, so only the #disposed
    // gate (now also set by notify) can stop the replay.
    h.armNotifyLostOnNextListening();
    await h.releaseTts();
    await h.awaitRepair();

    expect(h.brainTranscripts).toEqual([]);
  });

  it('still replays queued speech when the repair prompt TTS fails', async () => {
    const h = await makeRepairHarness({ ttsFailAfterRelease: true });

    await h.startRepair();
    expect(h.ttsTexts.length).toBe(1);

    await h.emit({ text: 'עדיין שומעים אותי', final: true });
    await h.endpoint();
    expect(h.brainTranscripts).toEqual([]);

    await h.releaseTts();
    await h.awaitRepair();

    expect(h.brainTranscripts).toEqual(['עדיין שומעים אותי']);
  });
});
