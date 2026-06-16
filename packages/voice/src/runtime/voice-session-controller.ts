import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import type { STTProvider, STTProviderTranscriptEvent } from '../providers/base/stt-provider.js';
import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { TransportProvider } from '../providers/base/transport-provider.js';
import type { VoiceSessionBudget } from '../cost/session-budget.js';
import {
  normalizeAudioFrame,
  parseAudioFormatSpec,
  type AudioFormatSpec,
} from './audio-resampler.js';
import { runVoiceTurn } from './run-turn.js';
import { createVoiceRuntimeSession, setVoiceSessionState, toVoiceSessionHello, type VoiceRuntimeSession } from './session.js';
import type { VoiceDefinition } from '../types/voice.js';
import type { VoiceEvent } from '../types/event.js';
import { createAgentStateEvent } from './events.js';

export type SttMode = 'client' | 'server';

export function resolveSttMode(voice: VoiceDefinition): SttMode {
  return voice.stt.provider === 'web-speech' ? 'client' : 'server';
}

export function isContinuousTransportMode(voice: VoiceDefinition): boolean {
  return voice.transport.mode === 'continuous';
}

export interface VoiceSessionControllerOptions {
  voice: VoiceDefinition;
  sessionId: string;
  userId?: string;
  ctx: ExecutionContext;
  sttProvider: STTProvider;
  ttsProvider: TTSProvider;
  transportProvider: TransportProvider;
  budget?: VoiceSessionBudget;
  sttAudioFormat?: AudioFormatSpec;
  onEvent: (event: VoiceEvent) => Promise<void> | void;
  onAudioChunk?: (chunk: Uint8Array) => Promise<void> | void;
  onActivity?: () => void;
  brainInput?: Record<string, unknown>;
}

export class VoiceSessionController {
  readonly session: VoiceRuntimeSession;
  readonly sttMode: SttMode;
  readonly continuousMode: boolean;
  #turnCount = 0;
  #turnInFlight = false;
  #pendingTranscript: string | undefined;
  #pendingLanguage: string | undefined;
  #listening = false;
  #sttConnected = false;
  #turnAbort?: AbortController;

  constructor(private readonly options: VoiceSessionControllerOptions) {
    this.session = createVoiceRuntimeSession({
      id: options.sessionId,
      voiceName: options.voice.name,
      transport: options.voice.transport.provider === 'livekit' ? 'livekit' : 'websocket',
      audioFormat: options.voice.transport.audioFormat,
      userId: options.userId,
    });
    this.sttMode = resolveSttMode(options.voice);
    this.continuousMode = isContinuousTransportMode(options.voice);
  }

  async hello(): Promise<void> {
    await this.#ensureServerSttConnected();
    await this.options.onEvent(toVoiceSessionHello(this.session, this.sttMode));
  }

  async #ensureServerSttConnected(): Promise<void> {
    if (this.sttMode === 'client' || this.#sttConnected) {
      return;
    }

    await this.options.sttProvider.connect?.({
      sessionId: this.session.id,
      onTranscript: async (event) => {
        await this.#handleServerTranscript(event);
      },
      onEndpoint: async () => {
        await this.#handleEndpoint();
      },
    });
    this.#sttConnected = true;
  }

  async #handleEndpoint(): Promise<void> {
    if (!this.continuousMode || this.#turnInFlight) {
      return;
    }
    if (!this.#pendingTranscript?.trim()) {
      return;
    }
    await this.runTurn();
  }

  async #handleServerTranscript(event: STTProviderTranscriptEvent): Promise<void> {
    this.options.onActivity?.();

    if (event.final) {
      this.#pendingTranscript = event.text;
      this.#pendingLanguage = event.language;
      const charCheck = this.options.budget?.check({ sttCharacters: event.text.length });
      if (charCheck && !charCheck.allowed) {
        await this.options.onEvent({
          type: 'error',
          code: 'voice.session_budget_exceeded',
          message: charCheck.reason ?? 'Voice session budget exceeded',
        });
        return;
      }
      this.options.budget?.record({ sttCharacters: event.text.length });
      await this.options.onEvent({
        type: 'stt.final',
        text: event.text,
        language: event.language,
        confidence: event.confidence,
      });

      if (this.continuousMode && !this.#turnInFlight) {
        await this.runTurn();
      }
      return;
    }

    const charCheck = this.options.budget?.check({ sttCharacters: event.text.length });
    if (charCheck && !charCheck.allowed) {
      await this.options.onEvent({
        type: 'error',
        code: 'voice.session_budget_exceeded',
        message: charCheck.reason ?? 'Voice session budget exceeded',
      });
      return;
    }

    await this.options.onEvent({
      type: 'stt.partial',
      text: event.text,
      language: event.language,
      confidence: event.confidence,
    });
  }

  async handleAudioChunk(chunk: Uint8Array, contentType?: string): Promise<void> {
    this.options.onActivity?.();
    if (this.sttMode === 'client') {
      return;
    }

    await this.#ensureServerSttConnected();

    if (!this.#listening) {
      this.#listening = true;
      setVoiceSessionState(this.session, 'Listening');
      await this.options.onEvent(createAgentStateEvent('Listening'));
    }

    const sourceFormat = parseAudioFormatSpec(contentType ?? this.session.audioFormat);
    const targetFormat =
      this.options.sttAudioFormat ?? parseAudioFormatSpec(this.session.audioFormat);
    const normalized = normalizeAudioFrame(
      { data: chunk, ...sourceFormat, format: 'pcm16' },
      { ...targetFormat, format: 'pcm16' },
    );

    const seconds = normalized.data.byteLength / (2 * normalized.channels * normalized.sampleRate);
    const budgetCheck = this.options.budget?.check({ audioInputSeconds: seconds });
    if (budgetCheck && !budgetCheck.allowed) {
      await this.options.onEvent({
        type: 'error',
        code: 'voice.session_budget_exceeded',
        message: budgetCheck.reason ?? 'Voice session budget exceeded',
      });
      return;
    }
    this.options.budget?.record({ audioInputSeconds: seconds });

    await this.options.sttProvider.sendAudio?.({
      chunk: normalized.data,
      contentType: `pcm16;rate=${normalized.sampleRate};channels=${normalized.channels}`,
    });
  }

  async handleControlMessage(payload: Record<string, unknown>): Promise<void> {
    this.options.onActivity?.();
    const type = typeof payload.type === 'string' ? payload.type : '';

    if (type === 'stt.partial') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      await this.#handleServerTranscript({
        text,
        final: false,
        language: typeof payload.language === 'string' ? payload.language : undefined,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
      });
      return;
    }

    if (type === 'stt.final') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      this.#pendingTranscript = text;
      this.#pendingLanguage =
        typeof payload.language === 'string' ? payload.language : undefined;
      if (this.options.voice.stt.provider === 'web-speech') {
        await this.options.sttProvider.onClientTranscript?.({
          text,
          final: true,
          language: this.#pendingLanguage,
          confidence:
            typeof payload.confidence === 'number' ? payload.confidence : undefined,
        });
      }
      await this.#handleServerTranscript({
        text,
        final: true,
        language: this.#pendingLanguage,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
      });
      return;
    }

    if (type === 'barge.in') {
      await this.bargeIn();
      return;
    }

    if (type === 'ptt.down') {
      this.#listening = true;
      setVoiceSessionState(this.session, 'Listening');
      await this.options.onEvent(createAgentStateEvent('Listening'));
      return;
    }

    if (type === 'ptt.up') {
      await this.runTurn(payload);
    }
  }

  async bargeIn(reason = 'User interrupted assistant playback'): Promise<void> {
    if (!this.#turnInFlight) {
      return;
    }

    this.#turnAbort?.abort();
    await this.options.ttsProvider.abortAll?.();
    await this.options.onEvent({
      type: 'turn.interrupted',
      sessionId: this.session.id,
      reason,
    });
    setVoiceSessionState(this.session, 'Listening');
    await this.options.onEvent(createAgentStateEvent('Listening'));
  }

  async runTurn(payload: Record<string, unknown> = {}): Promise<void> {
    if (this.#turnInFlight) {
      return;
    }

    this.#turnInFlight = true;
    this.#listening = false;
    const turnId = randomUUID();
    this.#turnCount += 1;
    this.#turnAbort = new AbortController();
    const abortSignal = this.#turnAbort.signal;
    const transcript = this.#pendingTranscript;
    const pendingLanguage = this.#pendingLanguage;
    this.#pendingTranscript = undefined;
    this.#pendingLanguage = undefined;

    try {
      const language =
        pendingLanguage ??
        (typeof payload.language === 'string' ? payload.language : undefined);
      const input =
        typeof payload.input === 'object' && payload.input !== null
          ? (payload.input as Record<string, unknown>)
          : undefined;

      for await (const _event of runVoiceTurn(this.options.ctx, {
        voiceDefinition: this.options.voice,
        sessionId: this.session.id,
        turnId,
        transcript,
        transcriptSource:
          this.options.voice.stt.provider === 'web-speech' ? 'client-stt' : 'server-stt',
        language,
        input: {
          ...(this.options.brainInput ?? {}),
          ...input,
        },
        sttProvider: this.options.sttProvider,
        ttsProvider: this.options.ttsProvider,
        transportProvider: this.options.transportProvider,
        cleanupProviders: false,
        abortSignal,
        onEvent: async (event) => {
          if (event.type === 'agent.state') {
            setVoiceSessionState(this.session, event.state);
          }
          await this.options.onEvent(event);
        },
        onAudioChunk: this.options.onAudioChunk,
        onAssistantDelta: async (delta) => {
          await this.options.onEvent({ type: 'assistant.delta', text: delta });
        },
      })) {
        // Events are forwarded through onEvent above.
      }
    } finally {
      const aborted = abortSignal.aborted;
      this.#turnInFlight = false;
      this.#turnAbort = undefined;
      if (!aborted) {
        setVoiceSessionState(this.session, this.continuousMode ? 'Listening' : 'Idle');
        await this.options.onEvent(
          createAgentStateEvent(this.continuousMode ? 'Listening' : 'Idle'),
        );
      }
    }
  }

  get turnCount(): number {
    return this.#turnCount;
  }

  async dispose(): Promise<void> {
    this.#turnAbort?.abort();
    await this.options.sttProvider.disconnect?.();
    await this.options.ttsProvider.flush?.();
    await this.options.transportProvider.disconnect?.();
  }

  async notifyTransportLost(reason = 'Transport connection closed'): Promise<void> {
    this.#turnAbort?.abort();
    setVoiceSessionState(this.session, 'Idle');
    await this.options.onEvent({
      type: 'error',
      code: 'transport_lost',
      message: reason,
    });
    await this.options.onEvent(createAgentStateEvent('Idle'));
  }
}
