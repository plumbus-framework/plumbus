import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { estimateVoiceTurnCost } from '../estimate-voice-turn-cost.js';

describe('estimateVoiceTurnCost', () => {
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

  it('maps cloud provider models via caller-supplied model tables', () => {
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
      sttModels: [
        {
          id: 'gpt-4o-transcribe',
          displayName: 'GPT-4o Transcribe',
          streaming: false,
          costModelKey: 'gpt-4o-transcribe',
        },
      ],
      ttsModels: [
        {
          id: 'tts-1-hd',
          displayName: 'tts-1-hd',
          streaming: true,
          costModelKey: 'tts-1-hd',
        },
      ],
    });

    expect(estimate.sttModelKey).toBe('gpt-4o-transcribe');
    expect(estimate.ttsModelKey).toBe('tts-1-hd');
    // Pricing for cloud models lives in add-on packages — builtin table returns 0.
    expect(estimate.estimatedCostUsd).toBe(0);
  });

  it('accepts add-on model tables without embedding vendor models in voice', () => {
    const voice = defineVoice({
      name: 'addonVoice',
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
      sttModels: [
        {
          id: 'stt-rt-preview',
          displayName: 'Soniox',
          streaming: true,
          costModelKey: 'soniox-stt',
        },
      ],
      ttsModels: [
        {
          id: 'speech-2.8-turbo',
          displayName: 'MiniMax turbo',
          streaming: true,
          costModelKey: 'minimax-speech-2.8-turbo',
        },
      ],
    });

    expect(estimate.sttModelKey).toBe('soniox-stt');
    expect(estimate.ttsModelKey).toBe('minimax-speech-2.8-turbo');
    // Pricing for add-on models lives in add-on packages — builtin table returns 0.
    expect(estimate.sttCostUsd).toBe(0);
    expect(estimate.ttsCostUsd).toBe(0);
  });
});
