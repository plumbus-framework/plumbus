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
  #turnQueuedWhileInFlight = false;
  /** A cumulative server-STT utterance is in progress (no endpoint yet). */
  #utteranceOpen = false;
  #disposed = false;
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
    // A provider callback chain suspended at an await can resume after the
    // session was torn down; without this gate it would start a full turn
    // against disconnected providers.
    if (this.#disposed) {
      return;
    }
    // After the STT provider signals end-of-speech we wait a short grace window
    // before starting the turn. If the user resumes speaking during that window
    // (a new transcript arrives, see #handleServerStreamingTranscript) the
    // pending turn is cancelled so we do not answer a half-finished sentence.
    this.#utteranceOpen = false;
    const graceMs = this.#endpointGraceMs();
    if (graceMs <= 0) {
      await this.#triggerServerTurn('endpoint');
      return;
    }
    this.#clearEndpointGraceTimer();
    this.#deferredEndpointTranscript = this.#pendingTranscript;
    const timer = setTimeout(() => {
      this.#endpointGraceTimer = undefined;
      // A rejection here (e.g. a failing hearing-repair TTS) has no awaiting
      // caller — without the catch it becomes an unhandled rejection that can
      // take down the whole worker process.
      this.#triggerServerTurn('endpoint').catch((error) => {
        console.error('[voice-session] deferred turn failed', {
          sessionId: this.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
      this.#utteranceOpen = true;
      this.#clearEndpointGraceTimer();
      const charCheck = this.options.budget?.check({ sttCharacters: text.length });
      if (charCheck && !charCheck.allowed) {
        await this.options.onEvent({
          type: 'error',
          code: 'voice.session_budget_exceeded',
          message: charCheck.reason ?? 'Voice session budget exceeded',
        });
        return;
      }
      // Server partials are cumulative per utterance, so the deferred fragment
      // must be re-prefixed on every event — consuming it on the first partial
      // would let the next cumulative partial clobber the pre-pause speech. It
      // stays set until a turn actually starts (or barge-in/dispose clears it).
      const deferred = this.#deferredEndpointTranscript?.trim();
      this.#pendingTranscript = deferred ? `${deferred} ${text}` : text;
      // Emit the STITCHED text, not the bare fragment: the client transcript
      // mirror shows these events live, and showing only the resumed fragment
      // makes the user's pre-pause speech silently vanish from the UI until
      // the turn commits (the model still receives the full pending text).
      await this.options.onEvent({
        type: event.final ? 'stt.final' : 'stt.partial',
        text: this.#pendingTranscript,
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
      // Same as the grace timer: no awaiting caller, so a rejection must be
      // contained here instead of crashing the worker.
      this.#triggerServerTurn('silence').catch((error) => {
        console.error('[voice-session] failsafe turn failed', {
          sessionId: this.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#serverSilenceMs());
    timer.unref?.();
    this.#serverTurnTimer = timer;
  }

  async #triggerServerTurn(source: 'endpoint' | 'silence'): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#clearServerTurnTimer();
    if (!this.continuousMode) {
      this.#clearDeferredEndpointTranscript();
      return;
    }
    if (this.#turnInFlight || this.#repairInFlight) {
      // Speech that completes while a reply or repair is being spoken must not
      // be dropped — losing it silently crosses conversation threads. Keep it
      // pending (and deferred, so any further speech stitches onto it) and
      // replay the endpoint once the in-flight work settles (see runTurn /
      // #runHearingRepair finally blocks).
      const queuedText = (this.#pendingTranscript ?? '').trim();
      if (queuedText.length > 0) {
        this.#turnQueuedWhileInFlight = true;
        if (source === 'endpoint') {
          // The provider closed the utterance, so snapshotting it as the
          // deferred prefix is safe — later speech starts a fresh cumulative
          // utterance and stitches onto it.
          this.#deferredEndpointTranscript = this.#pendingTranscript;
        } else {
          // Silence-failsafe: no provider endpoint fired, so the cumulative
          // utterance may still grow — a deferred snapshot would duplicate its
          // overlap on the next partial. Keep only pending (later partials
          // replace it wholesale) and treat the timer as the boundary so the
          // replay gate sees the utterance as closed.
          this.#utteranceOpen = false;
        }
        console.info('[voice-session] queueing speech during in-flight turn', {
          sessionId: this.session.id,
          source,
          chars: queuedText.length,
        });
      }
      return;
    }
    this.#clearDeferredEndpointTranscript();

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

    const gained =
      gainOptions.enableInputNormalization || (gainOptions.inputGainDb ?? 0) > 0
        ? applyPcm16InputGain(normalized.data, gainOptions)
        : { data: normalized.data, stats: inputLevels, appliedGainDb: 0 };

    // Gate speech energy on POST-gain levels (what STT actually hears). The
    // quiet/far-mic speakers input normalization exists for would otherwise
    // never cross the threshold — silently disabling the empty-endpoint
    // hearing repair for exactly the users who need it.
    const hasSpeechEnergy =
      Number.isFinite(gained.stats.peakDb) && gained.stats.peakDb > SPEECH_ENERGY_PEAK_DB;
    if (hasSpeechEnergy) {
      this.#hadSpeechEnergyInWindow = true;
      if (!this.#firstSpeechLevelLogged) {
        this.#firstSpeechLevelLogged = true;
        console.info('[voice-session] first speech-energy audio level', {
          sessionId: this.session.id,
          peakDb: roundDb(gained.stats.peakDb),
          rmsDb: roundDb(gained.stats.rmsDb),
          inputPeakDb: roundDb(inputLevels.peakDb),
          appliedGainDb: roundDb(gained.appliedGainDb),
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
    operationName: 'voice.hearing_repair' | 'voice.replay',
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
      const queued = this.#turnQueuedWhileInFlight;
      this.#turnQueuedWhileInFlight = false;
      if (this.continuousMode) {
        setVoiceSessionState(this.session, 'Listening');
        this.#listening = true;
        await this.options.onEvent(createAgentStateEvent('Listening'));
      }
      if (
        queued &&
        !this.#disposed &&
        !this.#utteranceOpen &&
        (this.#pendingTranscript ?? '').trim().length > 0
      ) {
        await this.#handleEndpoint();
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
      if (text.trim().length === 0) {
        // An empty final frame must not clobber a pending (possibly queued)
        // transcript — dropping real speech for an empty control frame.
        return;
      }
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
    // An explicit interrupt always cancels pending turn state — including a
    // turn waiting in the endpoint grace window (no turn in flight yet) and
    // any speech queued before the interrupt. Speech arriving AFTER the
    // barge-in queues fresh and is still replayed once the aborted turn
    // unwinds (see runTurn's finally).
    this.#turnQueuedWhileInFlight = false;
    this.#clearEndpointGraceTimer();
    this.#clearDeferredEndpointTranscript();

    if (!this.#turnInFlight) {
      this.#pendingTranscript = undefined;
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
    this.#clearEndpointGraceTimer();
    this.#clearDeferredEndpointTranscript();
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
      const queued = this.#turnQueuedWhileInFlight;
      this.#turnQueuedWhileInFlight = false;
      if (!aborted) {
        setVoiceSessionState(this.session, this.continuousMode ? 'Listening' : 'Idle');
        await this.options.onEvent(
          createAgentStateEvent(this.continuousMode ? 'Listening' : 'Idle'),
        );
      }
      // The replay runs even for an aborted (barged-in) turn: bargeIn() clears
      // the queued flag, so a flag still set here means the speech arrived
      // AFTER the interrupt — the user's fresh words, not the discarded turn.
      if (
        queued &&
        !this.#disposed &&
        !this.#utteranceOpen &&
        (this.#pendingTranscript ?? '').trim().length > 0
      ) {
        // Replay the queued endpoint through the normal grace window. Never
        // replay while a cumulative utterance is still open: deferring a
        // snapshot of an open utterance would duplicate its overlap on the
        // next partial, and the utterance's own endpoint will deliver the
        // stitched pending transcript anyway.
        await this.#handleEndpoint();
      }
    }
  }

  get turnCount(): number {
    return this.#turnCount;
  }

  async dispose(): Promise<void> {
    // A disposed session must never replay queued speech or accept a late
    // endpoint — a callback settling after teardown would otherwise start a
    // full brain+TTS turn against disconnected providers.
    this.#disposed = true;
    this.#turnQueuedWhileInFlight = false;
    this.#pendingTranscript = undefined;
    this.#clearServerTurnTimer();
    this.#clearEndpointGraceTimer();
    this.#clearDeferredEndpointTranscript();
    this.#turnAbort?.abort();
    await this.options.sttProvider.disconnect?.();
    await this.options.ttsProvider.flush?.();
    await this.options.transportProvider.disconnect?.();
  }

  async notifyTransportLost(reason = 'Transport connection closed'): Promise<void> {
    // Same dead-session gate as dispose(): a late endpoint, a newly armed
    // silence timer, or a repair/turn finally that already captured `queued`
    // must not start a brain+TTS turn against a dead transport. Provider
    // teardown still belongs to dispose() (http.ts / LiveKit call both).
    this.#disposed = true;
    this.#turnQueuedWhileInFlight = false;
    this.#pendingTranscript = undefined;
    this.#clearEndpointGraceTimer();
    this.#clearServerTurnTimer();
    this.#clearDeferredEndpointTranscript();
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
