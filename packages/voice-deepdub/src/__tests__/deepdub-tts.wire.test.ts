import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { DEEPDUB_TTS_REGISTRATION } from '../deepdub-tts.js';

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
  credentialOptions: Record<string, unknown> = {},
) {
  const registry = createProviderRegistry({
    tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
  });
  return createTTSProvider({
    registry,
    providers: {
      providers: {
        deepdub: {
          apiKey: 'dd-key',
          // Reconnect spacing is zeroed by default so the retry tests do not
          // pay real seconds; the delay itself is asserted separately.
          options: { deepdubClientFactory, reconnectDelayMs: 0, ...credentialOptions },
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

  it('a tone-supplied voiceId overrides the static voice prompt (style-variant switching)', async () => {
    const captured: CapturedCall[] = [];
    const provider = createDeepdubProvider(makeFakeDeepdubFactory(captured), {});

    const tone = provider.mapDeliveryTone({
      profile: 'apologetic_repair',
      pace: 'slow',
      voiceId: 'style-variant-apologetic',
    });
    for await (const _chunk of provider.synthesizeStream('סליחה, לא קלטתי', tone)) {
      // consume
    }

    expect(captured[0]?.params.voicePromptId).toBe('style-variant-apologetic');
  });

  it('without a tone voiceId the static voice prompt is used', async () => {
    const captured: CapturedCall[] = [];
    const provider = createDeepdubProvider(makeFakeDeepdubFactory(captured), {});

    const tone = provider.mapDeliveryTone({ profile: 'warm_default', warmth: 'high' });
    for await (const _chunk of provider.synthesizeStream('שלום', tone)) {
      // consume
    }

    expect(captured[0]?.params.voicePromptId).toBe('voice-he');
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

  it('keeps reconnecting up to three times and recovers on the last one', async () => {
    let connectCount = 0;
    let generateCount = 0;
    const provider = createDeepdubProvider(
      () => ({
        async connect() {
          connectCount += 1;
          return {};
        },
        async generateToBuffer(_text: string, params: Record<string, unknown> = {}) {
          generateCount += 1;
          // Initial attempt plus the first two retries all find a dead socket.
          if (generateCount <= 3) {
            throw new Error('WebSocket is not connected. Call connect() first.');
          }
          (params.onChunk as ((c: Uint8Array) => void) | undefined)?.(Buffer.from([9, 9]));
          return Buffer.from([9, 9]);
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('שלום', undefined)) {
      chunks.push(chunk);
    }

    expect(generateCount).toBe(4);
    expect(connectCount).toBe(4);
    expect(chunks).toHaveLength(1);
  });

  it('gives up after three reconnects and surfaces the last error', async () => {
    let generateCount = 0;
    const provider = createDeepdubProvider(
      () => ({
        async connect() {
          return {};
        },
        async generateToBuffer() {
          generateCount += 1;
          throw new Error('WebSocket is not connected. Call connect() first.');
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
    );

    await expect(async () => {
      for await (const _chunk of provider.synthesizeStream('שלום', undefined)) {
        // drain
      }
    }).rejects.toThrow('WebSocket is not connected');
    // One initial attempt + RECONNECT_ATTEMPTS retries.
    expect(generateCount).toBe(4);
  });

  it('waits between reconnect attempts instead of hammering the socket', async () => {
    let generateCount = 0;
    const provider = createDeepdubProvider(
      () => ({
        async connect() {
          return {};
        },
        async generateToBuffer(_text: string, params: Record<string, unknown> = {}) {
          generateCount += 1;
          if (generateCount === 1) {
            throw new Error('WebSocket is not connected. Call connect() first.');
          }
          if (generateCount === 2) {
            throw new Error('WebSocket is not connected. Call connect() first.');
          }
          (params.onChunk as ((c: Uint8Array) => void) | undefined)?.(Buffer.from([1]));
          return Buffer.from([1]);
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
      { reconnectDelayMs: 40 },
    );

    const startedAt = Date.now();
    for await (const _chunk of provider.synthesizeStream('שלום', undefined)) {
      // drain
    }
    // First retry is immediate; the second waits one delay.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    expect(generateCount).toBe(3);
  });

  it('does not re-synthesize once audio has already been published', async () => {
    // Retrying after the listener has heard the opening would replay it.
    let generateCount = 0;
    const provider = createDeepdubProvider(
      () => ({
        async connect() {
          return {};
        },
        async generateToBuffer(_text: string, params: Record<string, unknown> = {}) {
          generateCount += 1;
          (params.onChunk as ((c: Uint8Array) => void) | undefined)?.(Buffer.from([7]));
          throw new Error('WebSocket is not connected. Call connect() first.');
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
    );

    const chunks: Uint8Array[] = [];
    await expect(async () => {
      for await (const chunk of provider.synthesizeStream('שלום', undefined)) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('WebSocket is not connected');
    expect(generateCount).toBe(1);
    expect(chunks).toHaveLength(1);
  });

  it('stops reconnecting when the turn is aborted', async () => {
    let generateCount = 0;
    const controller = new AbortController();
    const provider = createDeepdubProvider(
      () => ({
        async connect() {
          return {};
        },
        async generateToBuffer() {
          generateCount += 1;
          controller.abort();
          throw new Error('WebSocket is not connected. Call connect() first.');
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
    );

    for await (const _chunk of provider.synthesizeStream('שלום', undefined, controller.signal)) {
      // drain
    }
    // An aborted turn stops consuming immediately, so the retry — if it ran at
    // all — would run detached. Give it a window to prove it does not.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(generateCount).toBe(1);
  });

  it('retries a refused initial connection before failing the turn', async () => {
    let connectCount = 0;
    const provider = createDeepdubProvider(
      () => ({
        async connect() {
          connectCount += 1;
          if (connectCount < 3) {
            throw new Error('connect ECONNREFUSED');
          }
          return {};
        },
        async generateToBuffer(_text: string, params: Record<string, unknown> = {}) {
          (params.onChunk as ((c: Uint8Array) => void) | undefined)?.(Buffer.from([5]));
          return Buffer.from([5]);
        },
        disconnect() {},
      }),
      { targetGender: 'female' },
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('שלום', undefined)) {
      chunks.push(chunk);
    }

    expect(connectCount).toBe(3);
    expect(chunks).toHaveLength(1);
  });
});
