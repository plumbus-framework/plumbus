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
import {
  assessHearingRepairNeeded,
  speakDirectUtterance,
  type HearingRepairReason,
} from './hearing-repair.js';
import {
  applyPcm16InputGain,
  analyzePcm16Levels,
  resolvePcm16InputGainOptions,
} from './pcm-input-gain.js';
import { runVoiceTurn } from './run-turn.js';
import {
  createVoiceRuntimeSession,
  setVoiceSessionState,
  toVoiceSessionHello,
  type VoiceRuntimeSession,
} from './session.js';
import type { VoiceDefinition } from '../types/voice.js';
import type { VoiceEvent } from '../types/event.js';
import { createAgentStateEvent } from './events.js';

export type SttMode = 'client' | 'server';

/** Peak dBFS above which incoming mic audio counts as real speech energy. */
const SPEECH_ENERGY_PEAK_DB = -45;

/**
 * Failsafe silence (ms) after the last transcript before a server-STT turn fires,
 * used only if the provider never emits an endpoint. Kept longer than Soniox's
 * `max_endpoint_delay_ms` so the real endpoint signal wins in normal operation.
 */
const DEFAULT_SERVER_SILENCE_MS = 4000;

/** Remove Soniox control markers (`<end>`, `<fin>`) from transcript text (defensive). */
function stripEndpointMarkers(text: string): string {
  return text.replace(/<end>|<fin>/gi, '');
}

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
  #repairInFlight = false;
  #pendingTranscript: string | undefined;
  #pendingLanguage: string | undefined;
  #pendingConfidence: number | undefined;
  #serverTurnTimer?: ReturnType<typeof setTimeout>;
  #listening = false;
  #sttConnected = false;
  #firstAudioLogged = false;
  #firstSpeechLevelLogged = false;
  #lowLevelWarningLogged = false;
  #hadSpeechEnergyInWindow = false;
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
    // An explicit end-of-speech signal from the provider triggers the turn
    // immediately; the silence-debounce in #handleServerStreamingTranscript is the
    // fallback for providers/configs that do not emit one.
    await this.#triggerServerTurn('endpoint');
  }

  #resetListeningWindow(): void {
    this.#hadSpeechEnergyInWindow = false;
  }

  async #handleServerTranscript(event: STTProviderTranscriptEvent): Promise<void> {
    this.options.onActivity?.();

    if (this.sttMode === 'server') {
      await this.#handleServerStreamingTranscript(event);
      return;
    }

    await this.#handleClientContinuousTranscript(event);
  }

  async #handleClientContinuousTranscript(event: STTProviderTranscriptEvent): Promise<void> {
    if (event.final) {
      this.#pendingTranscript = event.text;
      this.#pendingLanguage = event.language;
      this.#pendingConfidence = event.confidence;
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

      if (this.continuousMode && !this.#turnInFlight && !this.#repairInFlight) {
        const repair = this.#assessRepair({
          transcript: event.text,
          confidence: event.confidence,
          language: event.language,
          trigger: 'final',
        });
        if (repair.needed && repair.prompt) {
          this.#pendingTranscript = undefined;
          this.#pendingLanguage = undefined;
          this.#pendingConfidence = undefined;
          this.#resetListeningWindow();
          await this.#runHearingRepair(repair.reason ?? 'uncertain_name', repair.prompt);
          return;
        }
        this.#resetListeningWindow();
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

  /**
   * Server STT (the @soniox/node SDK) emits a clean transcript per utterance and a
   * reliable `endpoint` event at end-of-speech. We keep the latest utterance text as
   * the pending transcript and trigger the turn on the endpoint (see #handleEndpoint),
   * with a long silence failsafe in case an endpoint is ever missed.
   */
  async #handleServerStreamingTranscript(event: STTProviderTranscriptEvent): Promise<void> {
    const text = stripEndpointMarkers(typeof event.text === 'string' ? event.text : '').trim();
    this.#pendingLanguage = event.language;
    this.#pendingConfidence = event.confidence;

    if (text.length > 0) {
      const charCheck = this.options.budget?.check({ sttCharacters: text.length });
      if (charCheck && !charCheck.allowed) {
        await this.options.onEvent({
          type: 'error',
          code: 'voice.session_budget_exceeded',
          message: charCheck.reason ?? 'Voice session budget exceeded',
        });
        return;
      }
      this.#pendingTranscript = text;
      await this.options.onEvent({
        type: event.final ? 'stt.final' : 'stt.partial',
        text,
        language: event.language,
        confidence: event.confidence,
      });
    }

    this.#scheduleServerTurn();
  }

  #serverSilenceMs(): number {
    const configured = this.options.voice.stt.options?.endpointSilenceMs;
    return typeof configured === 'number' && configured > 0
      ? configured
      : DEFAULT_SERVER_SILENCE_MS;
  }

  #clearServerTurnTimer(): void {
    if (this.#serverTurnTimer) {
      clearTimeout(this.#serverTurnTimer);
      this.#serverTurnTimer = undefined;
    }
  }

  #scheduleServerTurn(): void {
    this.#clearServerTurnTimer();
    const timer = setTimeout(() => {
      this.#serverTurnTimer = undefined;
      void this.#triggerServerTurn('silence');
    }, this.#serverSilenceMs());
    timer.unref?.();
    this.#serverTurnTimer = timer;
  }

  async #triggerServerTurn(source: 'endpoint' | 'silence'): Promise<void> {
    this.#clearServerTurnTimer();
    if (!this.continuousMode || this.#turnInFlight || this.#repairInFlight) {
      return;
    }

    const utterance = (this.#pendingTranscript ?? '').trim();
    if (!utterance) {
      const repair = this.#assessRepair({
        transcript: '',
        trigger: 'endpoint',
        hadSpeechEnergy: this.#hadSpeechEnergyInWindow,
      });
      this.#resetListeningWindow();
      if (repair.needed && repair.prompt) {
        await this.#runHearingRepair(repair.reason ?? 'empty', repair.prompt);
      }
      return;
    }

    const repair = this.#assessRepair({
      transcript: utterance,
      confidence: this.#pendingConfidence,
      language: this.#pendingLanguage,
      trigger: 'endpoint',
    });
    if (repair.needed && repair.prompt) {
      this.#pendingTranscript = undefined;
      this.#pendingLanguage = undefined;
      this.#pendingConfidence = undefined;
      this.#resetListeningWindow();
      await this.#runHearingRepair(repair.reason ?? 'uncertain_name', repair.prompt);
      return;
    }

    this.options.budget?.record({ sttCharacters: utterance.length });
    this.#pendingTranscript = utterance;
    this.#resetListeningWindow();
    console.info('[voice-session] turn trigger', {
      source,
      sessionId: this.session.id,
      turn: this.#turnCount + 1,
      chars: utterance.length,
    });
    await this.runTurn();
  }

  async handleAudioChunk(chunk: Uint8Array, contentType?: string): Promise<void> {
    this.options.onActivity?.();
    if (this.sttMode === 'client') {
      return;
    }

    if (!this.#firstAudioLogged) {
      this.#firstAudioLogged = true;
      console.info('[voice-session] first audio chunk received', {
        sessionId: this.session.id,
        bytes: chunk.byteLength,
      });
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

    const gainOptions = resolvePcm16InputGainOptions(this.options.voice.stt.options);
    const inputLevels = analyzePcm16Levels(normalized.data);
    const hasSpeechEnergy =
      Number.isFinite(inputLevels.peakDb) && inputLevels.peakDb > SPEECH_ENERGY_PEAK_DB;
    if (hasSpeechEnergy) {
      this.#hadSpeechEnergyInWindow = true;
      if (!this.#firstSpeechLevelLogged) {
        this.#firstSpeechLevelLogged = true;
        console.info('[voice-session] first speech-energy audio level', {
          sessionId: this.session.id,
          peakDb: roundDb(inputLevels.peakDb),
          rmsDb: roundDb(inputLevels.rmsDb),
        });
      }
    } else if (!this.#lowLevelWarningLogged && Number.isFinite(inputLevels.peakDb)) {
      this.#lowLevelWarningLogged = true;
      console.warn('[voice-session] low input audio level (no speech energy detected yet)', {
        sessionId: this.session.id,
        peakDb: roundDb(inputLevels.peakDb),
        rmsDb: roundDb(inputLevels.rmsDb),
      });
    }

    const gained =
      gainOptions.enableInputNormalization || (gainOptions.inputGainDb ?? 0) > 0
        ? applyPcm16InputGain(normalized.data, gainOptions)
        : { data: normalized.data, stats: inputLevels, appliedGainDb: 0 };

    const sttChunk = gained.data;

    const seconds = sttChunk.byteLength / (2 * normalized.channels * normalized.sampleRate);
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
      chunk: sttChunk,
      contentType: `pcm16;rate=${normalized.sampleRate};channels=${normalized.channels}`,
    });
  }

  #assessRepair(args: {
    transcript?: string;
    confidence?: number;
    language?: string;
    trigger?: 'endpoint' | 'final';
    hadSpeechEnergy?: boolean;
  }) {
    const sttOptions = this.options.voice.stt.options;
    const lowConfidenceThreshold =
      typeof sttOptions?.lowConfidenceThreshold === 'number'
        ? sttOptions.lowConfidenceThreshold
        : undefined;
    return assessHearingRepairNeeded({
      transcript: args.transcript,
      confidence: args.confidence,
      language: args.language ?? this.#getSessionLanguage(),
      lowConfidenceThreshold,
      trigger: args.trigger,
      hadSpeechEnergy: args.hadSpeechEnergy,
    });
  }

  #getSessionLanguage(): string | undefined {
    const language = this.options.brainInput?.language;
    return typeof language === 'string' ? language : undefined;
  }

  async #runHearingRepair(reason: HearingRepairReason, prompt: string): Promise<void> {
    if (this.#repairInFlight || this.#turnInFlight) {
      return;
    }

    this.#repairInFlight = true;
    this.#listening = false;
    console.info('[voice-session] hearing repair', {
      sessionId: this.session.id,
      reason,
      promptLength: prompt.length,
    });

    try {
      setVoiceSessionState(this.session, 'Synthesizing');
      await this.options.onEvent(createAgentStateEvent('Synthesizing'));
      await speakDirectUtterance({
        text: prompt,
        ttsProvider: this.options.ttsProvider,
        transportProvider: this.options.transportProvider,
        onEvent: this.options.onEvent,
        onAudioChunk: this.options.onAudioChunk,
        abortSignal: this.#turnAbort?.signal,
      });
    } finally {
      this.#repairInFlight = false;
      if (this.continuousMode) {
        setVoiceSessionState(this.session, 'Listening');
        this.#listening = true;
        await this.options.onEvent(createAgentStateEvent('Listening'));
      }
    }
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
      this.#pendingLanguage = typeof payload.language === 'string' ? payload.language : undefined;
      this.#pendingConfidence =
        typeof payload.confidence === 'number' ? payload.confidence : undefined;
      if (this.options.voice.stt.provider === 'web-speech') {
        await this.options.sttProvider.onClientTranscript?.({
          text,
          final: true,
          language: this.#pendingLanguage,
          confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
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
    this.#pendingConfidence = undefined;

    try {
      const language =
        pendingLanguage ?? (typeof payload.language === 'string' ? payload.language : undefined);
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
    this.#clearServerTurnTimer();
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

function roundDb(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.round(value * 10) / 10;
}
