import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import type { STTProviderTranscriptEvent } from '../../providers/base/stt-provider.js';
import type { VoiceEvent } from '../../types/event.js';
import { isVoiceTurnSuperseded, VOICE_TURN_SUPERSEDED_REASON } from '../turn-superseded.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await sleep(5);
  }
  expect(check()).toBe(true);
}

interface BrainCall {
  transcript: string;
  signal?: AbortSignal;
  turnId?: string;
  supersededTurnId?: string;
}

async function makeHarness(
  opts: {
    whileWriting?: 'queue' | 'restart';
    /** Brain keeps writing after an abort (a provider that ignores the signal). */
    brainIgnoresAbort?: boolean;
    /** Hold speech synthesis of the first reply until released. */
    holdFirstSynthesis?: boolean;
  } = {},
) {
  const calls: BrainCall[] = [];
  const events: VoiceEvent[] = [];
  let onTranscript: ((event: STTProviderTranscriptEvent) => Promise<void>) | undefined;
  let onEndpoint: (() => Promise<void>) | undefined;
  let releaseBrain: (() => void) | undefined;
  let releaseSynthesis: (() => void) | undefined;
  let blockBrain = true;
  let holdSynthesis = opts.holdFirstSynthesis === true;

  const voice = defineVoice({
    name: 'writingVoice',
    access: {},
    transport: { provider: 'livekit', mode: 'continuous' },
    stt: { provider: 'mock-stt', options: { endpointSilenceMs: 0 } },
    tts: { provider: 'mock-tts', responseMode: 'reply' },
    ...(opts.whileWriting ? { interruptions: { whileWriting: opts.whileWriting } } : {}),
    brain: {
      async run(_ctx, args) {
        calls.push({
          transcript: args.transcript ?? '',
          signal: args.signal,
          turnId: args.turnId,
          supersededTurnId: args.supersededTurnId,
        });
        if (blockBrain) {
          blockBrain = false;
          await new Promise<void>((resolve) => {
            releaseBrain = resolve;
            if (!opts.brainIgnoresAbort) {
              args.signal?.addEventListener('abort', () => resolve(), { once: true });
            }
          });
          args.onAssistantDelta?.('first reply');
        }
        return { text: `reply to ${args.transcript}` };
      },
    },
  });

  const baseStt = createMockSTTProvider({
    connect(args) {
      onTranscript = args.onTranscript;
      onEndpoint = args.onEndpoint;
    },
  });

  const controller = new VoiceSessionController({
    voice,
    sessionId: 'writing-session',
    ctx: createTestContext(),
    sttProvider: {
      ...baseStt,
      capabilities: { ...baseStt.capabilities, endpointDetection: true },
    },
    ttsProvider: createMockTTSProvider({
      async *synthesizeStream() {
        if (holdSynthesis) {
          holdSynthesis = false;
          await new Promise<void>((resolve) => {
            releaseSynthesis = resolve;
          });
        }
        yield new Uint8Array([1]);
      },
    }),
    transportProvider: createMockTransportProvider(),
    onEvent: async (event) => {
      events.push(event);
    },
  });
  await controller.hello();

  return {
    controller,
    calls,
    events,
    say: async (text: string, final = false) => {
      await onTranscript?.({ text, final });
    },
    endpoint: async () => {
      await onEndpoint?.();
    },
    brainWriting: () => releaseBrain !== undefined,
    releaseBrain: () => {
      releaseBrain?.();
      releaseBrain = undefined;
    },
    synthesisHeld: () => releaseSynthesis !== undefined,
    releaseSynthesis: () => {
      releaseSynthesis?.();
      releaseSynthesis = undefined;
    },
  };
}

function interruptions(events: VoiceEvent[]) {
  return events.filter((event) => event.type === 'turn.interrupted');
}

describe('VoiceSessionController interruptions.whileWriting', () => {
  it("'restart': speech while the reply is written aborts it and runs one combined turn", async () => {
    const h = await makeHarness({ whileWriting: 'restart' });

    await h.say('My father had a shop', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);

    await h.say('in Haifa');
    expect(h.calls[0]?.signal?.aborted).toBe(true);
    expect(isVoiceTurnSuperseded(h.calls[0]?.signal)).toBe(true);
    expect(interruptions(h.events)).toEqual([
      { type: 'turn.interrupted', sessionId: 'writing-session', reason: 'superseded' },
    ]);
    // The client mirror shows the combined answer while the user speaks.
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'stt.partial', text: 'My father had a shop in Haifa' }),
    );

    await firstTurn;
    await h.say('in Haifa near the port', true);
    await h.endpoint();

    expect(h.calls.map((call) => call.transcript)).toEqual([
      'My father had a shop',
      'My father had a shop in Haifa near the port',
    ]);
    expect(h.calls[1]?.signal?.aborted).toBe(false);
    // The combined turn names the turn it replaces, so the brain can discard its records.
    expect(h.calls[0]?.turnId).toEqual(expect.any(String));
    expect(h.calls[0]?.supersededTurnId).toBeUndefined();
    expect(h.calls[1]?.supersededTurnId).toBe(h.calls[0]?.turnId);
    expect(h.calls[1]?.turnId).not.toBe(h.calls[0]?.turnId);
    // Nothing from the superseded turn reaches the client.
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ type: 'assistant.delta', text: 'first reply' }),
    );
    expect(
      h.events.filter((event) => event.type === 'turn.completed').map((event) => event),
    ).toEqual([
      expect.objectContaining({
        transcript: 'My father had a shop in Haifa near the port',
        responseText: 'reply to My father had a shop in Haifa near the port',
      }),
    ]);
  });

  it("'restart': an endpoint before the aborted turn unwinds replays the combined turn after it", async () => {
    const h = await makeHarness({ whileWriting: 'restart', brainIgnoresAbort: true });

    await h.say('We moved in 1962', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);

    await h.say('to Beersheba', true);
    await h.endpoint();
    expect(h.controller.turnCount).toBe(1);

    h.releaseBrain();
    await firstTurn;

    expect(h.calls.map((call) => call.transcript)).toEqual([
      'We moved in 1962',
      'We moved in 1962 to Beersheba',
    ]);
    expect(h.calls[1]?.supersededTurnId).toBe(h.calls[0]?.turnId);
    expect(h.controller.turnCount).toBe(2);
    // The aborted reply is never synthesized or completed.
    expect(
      h.events.filter((event) => event.type === 'turn.completed').map((event) => event),
    ).toEqual([expect.objectContaining({ transcript: 'We moved in 1962 to Beersheba' })]);
  });

  it("'restart': supersedes once even when the user keeps talking", async () => {
    const h = await makeHarness({ whileWriting: 'restart', brainIgnoresAbort: true });

    await h.say('A', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);

    await h.say('B');
    await h.say('B C');
    await h.say('B C D', true);
    expect(interruptions(h.events)).toHaveLength(1);

    h.releaseBrain();
    await firstTurn;
    await h.endpoint();

    expect(h.calls.map((call) => call.transcript)).toEqual(['A', 'A B C D']);
  });

  it("'restart': speech after synthesis started keeps the queue behaviour", async () => {
    const h = await makeHarness({ whileWriting: 'restart', holdFirstSynthesis: true });

    await h.say('First answer', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);
    h.releaseBrain();
    await waitFor(h.synthesisHeld);

    await h.say('more words', true);
    await h.endpoint();
    expect(interruptions(h.events)).toEqual([]);
    expect(h.calls[0]?.signal?.aborted).toBe(false);

    h.releaseSynthesis();
    await firstTurn;

    expect(h.calls.map((call) => call.transcript)).toEqual(['First answer', 'more words']);
  });

  it("default ('queue'): speech while the reply is written is answered as the next turn", async () => {
    const h = await makeHarness({ brainIgnoresAbort: true });

    await h.say('A', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);

    await h.say('B', true);
    await h.endpoint();
    expect(h.calls[0]?.signal?.aborted).toBe(false);
    expect(interruptions(h.events)).toEqual([]);

    h.releaseBrain();
    await firstTurn;

    expect(h.calls.map((call) => call.transcript)).toEqual(['A', 'B']);
    expect(h.calls[1]?.supersededTurnId).toBeUndefined();
  });

  it("'restart': a barge-in after a supersede drops the pending speech and the superseded id", async () => {
    const h = await makeHarness({ whileWriting: 'restart' });

    await h.say('A', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);
    await h.say('B');
    await firstTurn;

    await h.controller.bargeIn();
    await h.say('X', true);
    await h.endpoint();

    expect(h.calls.map((call) => call.transcript)).toEqual(['A', 'X']);
    expect(h.calls[1]?.supersededTurnId).toBeUndefined();
  });

  it('a superseded turn is not counted as a barge-in, and barge-in still aborts the turn', async () => {
    const h = await makeHarness({ whileWriting: 'restart' });

    await h.say('A', true);
    const firstTurn = h.endpoint();
    await waitFor(h.brainWriting);
    await h.controller.bargeIn();
    await firstTurn;

    expect(h.calls[0]?.signal?.aborted).toBe(true);
    expect(isVoiceTurnSuperseded(h.calls[0]?.signal)).toBe(false);
    expect(interruptions(h.events)).toEqual([
      expect.objectContaining({ reason: 'User interrupted assistant playback' }),
    ]);
  });
});

describe('interruptions config', () => {
  it('rejects an unknown whileWriting value', () => {
    expect(() =>
      defineVoice({
        name: 'badVoice',
        access: {},
        transport: { provider: 'livekit', mode: 'continuous' },
        stt: { provider: 'mock-stt' },
        tts: { provider: 'mock-tts' },
        interruptions: { whileWriting: 'drop' as 'queue' },
        brain: { run: async () => ({ text: 'x' }) },
      }),
    ).toThrow(/interruptions\.whileWriting/);
  });

  it('isVoiceTurnSuperseded reads only the superseded abort reason', () => {
    const superseded = new AbortController();
    superseded.abort(VOICE_TURN_SUPERSEDED_REASON);
    const other = new AbortController();
    other.abort();
    expect(isVoiceTurnSuperseded(superseded.signal)).toBe(true);
    expect(isVoiceTurnSuperseded(other.signal)).toBe(false);
    expect(isVoiceTurnSuperseded(new AbortController().signal)).toBe(false);
    expect(isVoiceTurnSuperseded(undefined)).toBe(false);
  });
});
