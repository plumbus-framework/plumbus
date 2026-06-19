import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createSTTProvider } from '../../factory.js';

type Handler = (...args: unknown[]) => void;

class FakeSonioxSession {
  readonly handlers: Record<string, Handler[]> = {};
  readonly audioChunks: Uint8Array[] = [];
  connected = false;
  finalizeCount = 0;
  closed = false;

  on(event: string, handler: Handler): this {
    const list = this.handlers[event] ?? [];
    list.push(handler);
    this.handlers[event] = list;
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers[event] ?? []) {
      handler(...args);
    }
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  sendAudio(data: Uint8Array): void {
    this.audioChunks.push(data);
  }
  finalize(): void {
    this.finalizeCount += 1;
  }
  async finish(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
}

function makeFactory(session: FakeSonioxSession, captured: { config?: Record<string, unknown> }) {
  return () => ({
    realtime: {
      stt(config: Record<string, unknown>) {
        captured.config = config;
        return session;
      },
    },
  });
}

function createSonioxProvider(
  session: FakeSonioxSession,
  captured: { config?: Record<string, unknown> },
) {
  const registry = createProviderRegistry();
  return createSTTProvider({
    registry,
    providers: {
      providers: {
        soniox: {
          apiKey: 'soniox-key',
          options: { sonioxClientFactory: makeFactory(session, captured) },
        },
      },
    },
    voiceSlice: {
      provider: 'soniox',
      model: 'stt-rt-v5',
      languages: ['he', 'en'],
      options: {
        enableEndpointDetection: true,
        maxEndpointDelayMs: 3000,
        contextTerms: ['AcmeApp'],
      },
    },
  });
}

describe('Soniox STT via @soniox/node SDK', () => {
  it('opens a real-time session with the configured options and streams audio', async () => {
    const session = new FakeSonioxSession();
    const captured: { config?: Record<string, unknown> } = {};
    const provider = createSonioxProvider(session, captured);

    await provider.connect?.({ sessionId: 'soniox-1' });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'pcm16;rate=16000;channels=1',
    });

    expect(session.connected).toBe(true);
    expect(session.audioChunks).toHaveLength(1);
    expect(captured.config).toMatchObject({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['he', 'en'],
      enable_endpoint_detection: true,
      max_endpoint_delay_ms: 3000,
      context: { terms: ['AcmeApp'] },
    });
  });

  it('emits clean partial transcripts and fires onEndpoint with the final utterance', async () => {
    const session = new FakeSonioxSession();
    const captured: { config?: Record<string, unknown> } = {};
    const provider = createSonioxProvider(session, captured);

    const transcripts: STTLike[] = [];
    let endpoints = 0;
    await provider.connect?.({
      sessionId: 'soniox-2',
      onTranscript: (event) => {
        transcripts.push({ text: event.text, final: event.final });
      },
      onEndpoint: () => {
        endpoints += 1;
      },
    });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'pcm16;rate=16000;channels=1',
    });

    // Soniox finalizes word-by-word; the SDK fires `endpoint` at end-of-speech.
    session.emit('result', {
      tokens: [{ text: 'שלום', is_final: true, confidence: 0.95, language: 'he' }],
    });
    session.emit('result', {
      tokens: [{ text: ' עולם', is_final: true, confidence: 0.92, language: 'he' }],
    });
    session.emit('endpoint');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(endpoints).toBe(1);
    const final = transcripts.find((t) => t.final);
    expect(final?.text).toBe('שלום עולם');
    expect(transcripts.every((t) => !t.text.includes('<end>'))).toBe(true);
  });

  it('resets utterance state between endpoints (second utterance is independent)', async () => {
    const session = new FakeSonioxSession();
    const captured: { config?: Record<string, unknown> } = {};
    const provider = createSonioxProvider(session, captured);

    const finals: string[] = [];
    await provider.connect?.({
      sessionId: 'soniox-3',
      onTranscript: (event) => {
        if (event.final) finals.push(event.text);
      },
      onEndpoint: () => {},
    });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'pcm16;rate=16000;channels=1',
    });

    session.emit('result', { tokens: [{ text: 'first', is_final: true }] });
    session.emit('endpoint');
    session.emit('result', { tokens: [{ text: 'second', is_final: true }] });
    session.emit('endpoint');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(finals).toContain('first');
    expect(finals).toContain('second');
    expect(finals.some((t) => t.includes('firstsecond'))).toBe(false);
  });
});

interface STTLike {
  text: string;
  final: boolean;
}
