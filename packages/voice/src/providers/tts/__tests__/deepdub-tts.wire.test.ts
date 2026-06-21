import { describe, expect, it } from 'vitest';
import { createTTSProvider } from '../../factory.js';
import { createProviderRegistry } from '../../registry.js';

interface CapturedCall {
  apiKey: string;
  opts: { protocol: string };
  text: string;
  params: Record<string, unknown>;
}

function makeFakeDeepdubFactory(captured: CapturedCall[], chunk = Buffer.from([10, 20, 30, 40])) {
  return (apiKey: string, opts: { protocol: 'websocket' }) => ({
    async connect() {
      return {};
    },
    async generateToBuffer(text: string, params: Record<string, unknown> = {}) {
      captured.push({ apiKey, opts, text, params });
      const onChunk = params.onChunk as ((c: Uint8Array) => void) | undefined;
      onChunk?.(chunk);
      return chunk;
    },
    disconnect() {},
  });
}

function createDeepdubProvider(
  deepdubClientFactory: unknown,
  voiceOptions: Record<string, unknown>,
) {
  const registry = createProviderRegistry();
  return createTTSProvider({
    registry,
    providers: {
      providers: {
        deepdub: {
          apiKey: 'dd-key',
          options: { deepdubClientFactory },
        },
      },
    },
    voiceSlice: {
      provider: 'deepdub',
      model: 'dd-etts-3.2',
      voiceId: 'voice-he',
      locale: 'he-IL',
      options: voiceOptions,
    },
  });
}

describe('Deepdub TTS via @deepdub/node SDK', () => {
  it('synthesizes through the SDK with the proven Hebrew params and yields PCM chunks', async () => {
    const captured: CapturedCall[] = [];
    const provider = createDeepdubProvider(makeFakeDeepdubFactory(captured), {
      format: 'wav',
      sampleRate: 48000,
      targetGender: 'female',
      accentControl: { accentBaseLocale: 'he-IL', accentLocale: 'he-IL', accentRatio: 0.75 },
    });

    const chunks: Uint8Array[] = [];
    // No tone resolved (default delivery): params is undefined.
    for await (const chunk of provider.synthesizeStream('שלום', undefined)) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks.map((c) => Buffer.from(c)))).toEqual(Buffer.from([10, 20, 30, 40]));

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.apiKey).toBe('dd-key');
    expect(call?.opts).toEqual({ protocol: 'websocket' });
    expect(call?.text).toBe('שלום');
    expect(call?.params).toMatchObject({
      voicePromptId: 'voice-he',
      model: 'dd-etts-3.2',
      locale: 'he-IL',
      targetGender: 'female',
      accentControl: { accentBaseLocale: 'he-IL', accentLocale: 'he-IL', accentRatio: 0.75 },
      headerless: true,
    });
    // Default delivery: do NOT send shaping params, format, sampleRate, or realtime.
    expect(call?.params).not.toHaveProperty('tempo');
    expect(call?.params).not.toHaveProperty('variance');
    expect(call?.params).not.toHaveProperty('temperature');
    expect(call?.params).not.toHaveProperty('promptBoost');
    expect(call?.params).not.toHaveProperty('format');
    expect(call?.params).not.toHaveProperty('sampleRate');
    expect(call?.params).not.toHaveProperty('realtime');
  });

  it('includes delivery shaping params only when a tone profile is active', async () => {
    const captured: CapturedCall[] = [];
    const provider = createDeepdubProvider(makeFakeDeepdubFactory(captured), {
      targetGender: 'female',
    });

    const tone = provider.mapDeliveryTone({
      pace: 'slow',
      warmth: 'high',
      energy: 'low',
      emotion: 'gentle',
    });
    for await (const _chunk of provider.synthesizeStream('שלום', tone)) {
      // consume
    }

    const call = captured[0];
    expect(call?.params).toMatchObject({
      voicePromptId: 'voice-he',
      model: 'dd-etts-3.2',
      tempo: 0.85,
      promptBoost: true,
      headerless: true,
      // Tone carried no gender → falls back to the static voice option.
      targetGender: 'female',
    });
  });

  it('lets a per-turn targetGender from the resolved tone override the static voice option', async () => {
    const captured: CapturedCall[] = [];
    const provider = createDeepdubProvider(makeFakeDeepdubFactory(captured), {
      targetGender: 'female',
    });

    const tone = provider.mapDeliveryTone({
      profile: 'warm_default',
      warmth: 'high',
      targetGender: 'male',
    });
    for await (const _chunk of provider.synthesizeStream('שלום', tone)) {
      // consume
    }

    const call = captured[0];
    expect(call?.params.targetGender).toBe('male');
  });

  it('reconnects once when the Deepdub websocket drops before synthesis', async () => {
    const captured: CapturedCall[] = [];
    let connectCount = 0;
    let generateCount = 0;
    const provider = createDeepdubProvider(
      (apiKey: string, opts: { protocol: 'websocket' }) => ({
        async connect() {
          connectCount += 1;
          return {};
        },
        async generateToBuffer(text: string, params: Record<string, unknown> = {}) {
          generateCount += 1;
          if (generateCount === 1) {
            throw new Error('WebSocket is not connected. Call connect() first.');
          }
          captured.push({ apiKey, opts, text, params });
          const onChunk = params.onChunk as ((c: Uint8Array) => void) | undefined;
          onChunk?.(Buffer.from([1, 2, 3, 4]));
          return Buffer.from([1, 2, 3, 4]);
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('שלום', undefined)) {
      chunks.push(chunk);
    }

    expect(connectCount).toBe(2);
    expect(generateCount).toBe(2);
    expect(captured).toHaveLength(1);
    expect(chunks).toHaveLength(1);
  });
});
