import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { estimateVoiceTurnCost } from '../estimate-voice-turn-cost.js';

describe('estimateVoiceTurnCost', () => {
  it('maps soniox STT and minimax TTS to voice pricing models', () => {
    const voice = defineVoice({
      name: 'pricedVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'soniox', model: 'stt-rt-preview' },
      tts: { provider: 'minimax', model: 'speech-2.8-turbo', voiceId: 'voice-1' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const estimate = estimateVoiceTurnCost({
      voice,
      estimatedAudioInputSeconds: 60,
      estimatedResponseCharacters: 100,
    });

    expect(estimate.sttModelKey).toBe('soniox-stt');
    expect(estimate.ttsModelKey).toBe('minimax-speech-2.8-turbo');
    expect(estimate.sttCostUsd).toBeGreaterThan(0);
    expect(estimate.ttsCostUsd).toBeGreaterThan(0);
    expect(estimate.estimatedCostUsd).toBe(estimate.sttCostUsd + estimate.ttsCostUsd);
  });

  it('returns zero for client-side web-speech and browser-tts providers', () => {
    const voice = defineVoice({
      name: 'freeVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const estimate = estimateVoiceTurnCost({
      voice,
      estimatedAudioInputSeconds: 120,
      estimatedResponseCharacters: 500,
    });

    expect(estimate.estimatedCostUsd).toBe(0);
    expect(estimate.sttModelKey).toBeUndefined();
    expect(estimate.ttsModelKey).toBeUndefined();
  });

  it('maps openai-whisper and openai TTS models via costModelKey', () => {
    const voice = defineVoice({
      name: 'openaiVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'openai-whisper', model: 'gpt-4o-transcribe' },
      tts: { provider: 'openai', model: 'tts-1-hd', voiceId: 'alloy' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const estimate = estimateVoiceTurnCost({
      voice,
      estimatedAudioInputSeconds: 30,
      estimatedResponseCharacters: 50,
    });

    expect(estimate.sttModelKey).toBe('gpt-4o-transcribe');
    expect(estimate.ttsModelKey).toBe('tts-1-hd');
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0);
  });
});
