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
import { recordDirectUtteranceCost } from './record-provider-usage.js';
import {
  createVoiceRuntimeSession,
  setVoiceSessionState,
  toVoiceSessionHello,
  type VoiceRuntimeSession,
} from './session.js';
import type { VoiceDefinition } from '../types/voice.js';
import type { VoiceEvent } from '../types/event.js';
import { createAgentStateEvent } from './events.js';
import { resolveDeliveryTone } from './delivery-tone.js';
import { mapDeliveryToneForProvider } from './tone-mapper.js';

export type SttMode = 'client' | 'server';

/** Peak dBFS above which incoming mic audio counts as real speech energy. */
const SPEECH_ENERGY_PEAK_DB = -45;

/**
 * Failsafe silence (ms) after the last transcript before a server-STT turn fires.
 * Only used for providers that do NOT declare reliable endpoint detection
 * (`capabilities.endpointDetection`), or when an app explicitly re-enables the
 * failsafe via a positive `stt.options.endpointSilenceMs`. Providers that declare
 * `capabilities.endpointDetection` drive turns from their own end-of-speech
 * signal and skip this timer entirely.
 */
const DEFAULT_SERVER_SILENCE_MS = 4000;

/** Default reflective-pause duration before a backchannel continuer (ms). */
const DEFAULT_BACKCHANNEL_PAUSE_MS = 900;

/** Minimum pending transcript length before a backchannel may fire. */
const DEFAULT_BACKCHANNEL_MIN_TRANSCRIPT_CHARS = 40;

/** Minimum gap between backchannel continuers (ms). */
const DEFAULT_BACKCHANNEL_COOLDOWN_MS = 6000;

/** Fallback continuer when no phrase pool is configured. */
const DEFAULT_BACKCHANNEL_PHRASES = ['mm-hm'] as const;

/** Strip leaked in-stream control markers from transcript text (defensive). */
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
  #directSpeakInFlight = false;
  #pendingTranscript: string | undefined;
  #pendingLanguage: string | undefined;
  #pendingConfidence: number | undefined;
  #serverTurnTimer?: ReturnType<typeof setTimeout>;
  #endpointGraceTimer?: ReturnType<typeof setTimeout>;
  #deferredEndpointTranscript?: string;
  #listening = false;
  #sttConnected = false;
  #firstAudioLogged = false;
  #firstSpeechLevelLogged = false;
  #lowLevelWarningLogged = false;
  #hadSpeechEnergyInWindow = false;
  #turnAbort?: AbortController;
  #lastSpeechEnergyAt?: number;
  #lastBackchannelAt?: number;
  #backchannelInFlight = false;
  #backchannelAbort?: AbortController;
  #backchannelTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: VoiceSessionControllerOptions) {
    this.session = createVoiceRuntimeSession({
      id: options.sessionId,
      voiceName: options.voice.name,
      transport: options.voice.transport.provider,
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

    const endpointOnly = this.#serverEndpointIsReliable();
    console.info('[voice-session] server STT endpoint mode', {
      sessionId: this.session.id,
      provider: this.options.sttProvider.capabilities.id,
      mode: endpointOnly ? 'provider-endpoint-only' : 'silence-failsafe',
      ...(endpointOnly ? {} : { silenceMs: this.#serverSilenceMs() }),
    });
  }

  async #handleEndpoint(): Promise<void> {
    // After the STT provider signals end-of-speech we wait a short grace window
    // before starting the turn. If the user resumes speaking during that window
    // (a new transcript arrives, see #handleServerStreamingTranscript) the
    // pending turn is cancelled so we do not answer a half-finished sentence.
    this.#clearBackchannelTimer();
    this.#abortBackchannelInFlight();
    const graceMs = this.#endpointGraceMs();
    if (graceMs <= 0) {
      await this.#triggerServerTurn('endpoint');
      return;
    }
    this.#clearEndpointGraceTimer();
    this.#deferredEndpointTranscript = this.#pendingTranscript;
    const timer = setTimeout(() => {
      this.#endpointGraceTimer = undefined;
      void this.#triggerServerTurn('endpoint');
    }, graceMs);
    timer.unref?.();
    this.#endpointGraceTimer = timer;
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
   * Server STT streaming providers emit a clean transcript per utterance and a
   * reliable `endpoint` event at end-of-speech. We keep the latest utterance text as
   * the pending transcript and trigger the turn on the endpoint (see #handleEndpoint),
   * with a long silence failsafe in case an endpoint is ever missed.
   */
  async #handleServerStreamingTranscript(event: STTProviderTranscriptEvent): Promise<void> {
    const text = stripEndpointMarkers(typeof event.text === 'string' ? event.text : '').trim();
    this.#pendingLanguage = event.language;
    this.#pendingConfidence = event.confidence;

    if (text.length > 0) {
      // The user is speaking again after an endpoint: cancel the deferred turn
      // and keep listening so the full utterance is captured.
      this.#clearEndpointGraceTimer();
      this.#abortBackchannelInFlight();
      this.#clearBackchannelTimer();
      const charCheck = this.options.budget?.check({ sttCharacters: text.length });
      if (charCheck && !charCheck.allowed) {
        await this.options.onEvent({
          type: 'error',
          code: 'voice.session_budget_exceeded',
          message: charCheck.reason ?? 'Voice session budget exceeded',
        });
        return;
      }
      const deferred = this.#deferredEndpointTranscript?.trim();
      if (deferred) {
        this.#pendingTranscript = `${deferred} ${text}`;
        this.#deferredEndpointTranscript = undefined;
      } else {
        this.#pendingTranscript = text;
      }
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

  /**
   * True when the STT provider emits a reliable end-of-speech signal and the
   * voice has not disabled endpoint detection. Those providers drive turns
   * purely from `onEndpoint`, so the silence-timer failsafe is not scheduled.
   */
  #serverEndpointIsReliable(): boolean {
    if (!this.options.sttProvider.capabilities.endpointDetection) {
      return false;
    }
    return this.options.voice.stt.options?.enableEndpointDetection !== false;
  }

  #clearServerTurnTimer(): void {
    if (this.#serverTurnTimer) {
      clearTimeout(this.#serverTurnTimer);
      this.#serverTurnTimer = undefined;
    }
  }

  #endpointGraceMs(): number {
    const configured = this.options.voice.stt.options?.endpointGraceMs;
    return typeof configured === 'number' && configured >= 0 ? configured : 0;
  }

  #clearEndpointGraceTimer(): void {
    if (this.#endpointGraceTimer) {
      clearTimeout(this.#endpointGraceTimer);
      this.#endpointGraceTimer = undefined;
    }
  }

  #clearDeferredEndpointTranscript(): void {
    this.#deferredEndpointTranscript = undefined;
  }

  #backchannelEnabled(): boolean {
    return this.options.voice.stt.options?.backchannelEnabled === true;
  }

  #backchannelPauseMs(): number {
    const configured = this.options.voice.stt.options?.backchannelPauseMs;
    return typeof configured === 'number' && configured > 0
      ? configured
      : DEFAULT_BACKCHANNEL_PAUSE_MS;
  }

  #backchannelMinTranscriptChars(): number {
    const configured = this.options.voice.stt.options?.backchannelMinTranscriptChars;
    return typeof configured === 'number' && configured >= 0
      ? configured
      : DEFAULT_BACKCHANNEL_MIN_TRANSCRIPT_CHARS;
  }

  #backchannelCooldownMs(): number {
    const configured = this.options.voice.stt.options?.backchannelCooldownMs;
    return typeof configured === 'number' && configured >= 0
      ? configured
      : DEFAULT_BACKCHANNEL_COOLDOWN_MS;
  }

  #backchannelPhrasesForLanguage(language?: string): string[] {
    const configured = this.options.voice.stt.options?.backchannelPhrases;
    if (Array.isArray(configured)) {
      const phrases = configured.filter((value): value is string => typeof value === 'string');
      const trimmed = phrases.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0);
      if (trimmed.length > 0) {
        return trimmed;
      }
      return [...DEFAULT_BACKCHANNEL_PHRASES];
    }

    if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
      const map = configured as Record<string, unknown>;
      const prefix = language?.trim().toLowerCase().slice(0, 2);
      const candidates: unknown[] = [];
      if (prefix) {
        candidates.push(map[prefix]);
      }
      candidates.push(map.default);
      for (const value of Object.values(map)) {
        candidates.push(value);
      }
      for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
          continue;
        }
        const phrases = candidate.filter((value): value is string => typeof value === 'string');
        const trimmed = phrases
          .map((phrase) => phrase.trim())
          .filter((phrase) => phrase.length > 0);
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }

    return [...DEFAULT_BACKCHANNEL_PHRASES];
  }

  #clearBackchannelTimer(): void {
    if (this.#backchannelTimer) {
      clearTimeout(this.#backchannelTimer);
      this.#backchannelTimer = undefined;
    }
  }

  #abortBackchannelInFlight(): void {
    if (this.#backchannelAbort) {
      this.#backchannelAbort.abort();
      this.#backchannelAbort = undefined;
    }
    this.#backchannelInFlight = false;
  }

  #clearBackchannelState(): void {
    this.#clearBackchannelTimer();
    this.#abortBackchannelInFlight();
  }

  #canConsiderBackchannel(): boolean {
    if (!this.#backchannelEnabled()) {
      return false;
    }
    if (!this.continuousMode || !this.#listening) {
      return false;
    }
    if (
      this.#turnInFlight ||
      this.#repairInFlight ||
      this.#directSpeakInFlight ||
      this.#backchannelInFlight
    ) {
      return false;
    }
    if (this.#endpointGraceTimer) {
      return false;
    }
    const transcript = (this.#pendingTranscript ?? '').trim();
    if (transcript.length < this.#backchannelMinTranscriptChars()) {
      return false;
    }
    const cooldownMs = this.#backchannelCooldownMs();
    if (
      this.#lastBackchannelAt !== undefined &&
      Date.now() - this.#lastBackchannelAt < cooldownMs
    ) {
      return false;
    }
    return true;
  }

  #scheduleBackchannelTimer(): void {
    this.#clearBackchannelTimer();
    if (!this.#canConsiderBackchannel()) {
      return;
    }
    const pauseMs = this.#backchannelPauseMs();
    const timer = setTimeout(() => {
      this.#backchannelTimer = undefined;
      void this.#tryEmitBackchannel();
    }, pauseMs);
    timer.unref?.();
    this.#backchannelTimer = timer;
  }

  async #tryEmitBackchannel(): Promise<void> {
    const lastSpeechAt = this.#lastSpeechEnergyAt;
    if (lastSpeechAt === undefined) {
      return;
    }
    const silenceMs = Date.now() - lastSpeechAt;
    if (silenceMs < this.#backchannelPauseMs()) {
      return;
    }
    if (!this.#canConsiderBackchannel()) {
      return;
    }

    const language = this.#pendingLanguage ?? this.#getSessionLanguage();
    const phrases = this.#backchannelPhrasesForLanguage(language);
    const phrase = phrases[Math.floor(Math.random() * phrases.length)] ?? phrases[0];
    if (!phrase) {
      return;
    }

    this.#backchannelInFlight = true;
    this.#backchannelAbort = new AbortController();
    const abortSignal = this.#backchannelAbort.signal;

    console.info('[voice-session] backchannel', {
      sessionId: this.session.id,
      phrase,
      silenceMs,
      language,
    });

    try {
      await speakDirectUtterance({
        text: phrase,
        ttsProvider: this.options.ttsProvider,
        transportProvider: this.options.transportProvider,
        onEvent: this.options.onEvent,
        onAudioChunk: this.options.onAudioChunk,
        abortSignal,
        emitAssistantText: false,
        announcePlaying: false,
      });
      if (!abortSignal.aborted) {
        this.#lastBackchannelAt = Date.now();
        await this.#recordAuxiliaryTtsCost(phrase, 'voice.backchannel');
      }
    } finally {
      if (this.#backchannelAbort?.signal === abortSignal) {
        this.#backchannelAbort = undefined;
      }
      this.#backchannelInFlight = false;
    }
  }

  #scheduleServerTurn(): void {
    this.#clearServerTurnTimer();
    const explicitSilenceMs = this.options.voice.stt.options?.endpointSilenceMs;
    const explicitFailsafe = typeof explicitSilenceMs === 'number' && explicitSilenceMs > 0;
    // Providers with reliable endpoint detection drive turns from the endpoint
    // signal alone; only schedule the silence failsafe for providers that lack
    // it, or when an app explicitly opts back in via a positive endpointSilenceMs.
    if (this.#serverEndpointIsReliable() && !explicitFailsafe) {
      return;
    }
    const timer = setTimeout(() => {
      this.#serverTurnTimer = undefined;
      void this.#triggerServerTurn('silence');
    }, this.#serverSilenceMs());
    timer.unref?.();
    this.#serverTurnTimer = timer;
  }

  async #triggerServerTurn(source: 'endpoint' | 'silence'): Promise<void> {
    this.#clearServerTurnTimer();
    this.#clearDeferredEndpointTranscript();
    this.#clearBackchannelState();
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
      this.#abortBackchannelInFlight();
      this.#lastSpeechEnergyAt = Date.now();
      this.#scheduleBackchannelTimer();
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

  #getBrainProjectId(): string | undefined {
    const projectId = this.options.brainInput?.projectId;
    return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
  }

  async #recordAuxiliaryTtsCost(
    text: string,
    operationName: 'voice.backchannel' | 'voice.hearing_repair' | 'voice.replay',
  ): Promise<void> {
    await recordDirectUtteranceCost(this.options.ctx, {
      text,
      projectId: this.#getBrainProjectId(),
      sessionId: this.session.id,
      operationName,
      tts: this.options.voice.tts,
      provider: this.options.voice.tts.provider,
    });
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
      await this.#recordAuxiliaryTtsCost(prompt, 'voice.hearing_repair');
    } finally {
      this.#repairInFlight = false;
      if (this.continuousMode) {
        setVoiceSessionState(this.session, 'Listening');
        this.#listening = true;
        await this.options.onEvent(createAgentStateEvent('Listening'));
      }
    }
  }

  async #runClientSpeak(text: string): Promise<void> {
    if (this.#repairInFlight || this.#directSpeakInFlight) {
      return;
    }

    if (this.#turnInFlight) {
      await this.bargeIn('Client replay interrupted active turn');
    }

    this.#directSpeakInFlight = true;
    this.#listening = false;

    try {
      setVoiceSessionState(this.session, 'Synthesizing');
      await this.options.onEvent(createAgentStateEvent('Synthesizing'));
      const resolvedTone = await resolveDeliveryTone(this.options.ctx, this.options.voice, {
        userTranscript: text,
        language: this.#getSessionLanguage(),
        sessionId: this.session.id,
      });
      const mappedTone = mapDeliveryToneForProvider(this.options.ttsProvider, resolvedTone);
      await speakDirectUtterance({
        text,
        ttsProvider: this.options.ttsProvider,
        transportProvider: this.options.transportProvider,
        onEvent: this.options.onEvent,
        onAudioChunk: this.options.onAudioChunk,
        ttsParams: mappedTone.providerParams,
      });
      await this.#recordAuxiliaryTtsCost(text, 'voice.replay');
    } finally {
      this.#directSpeakInFlight = false;
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

    if (type === 'tts.speak') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (text) {
        await this.#runClientSpeak(text);
      }
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
    this.#clearEndpointGraceTimer();
    this.#clearDeferredEndpointTranscript();
    this.#clearBackchannelState();
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
    this.#clearEndpointGraceTimer();
    this.#clearDeferredEndpointTranscript();
    this.#clearBackchannelState();
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
    this.#clearEndpointGraceTimer();
    this.#clearDeferredEndpointTranscript();
    this.#clearBackchannelState();
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
