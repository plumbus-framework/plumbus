import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { TransportProvider } from '../providers/base/transport-provider.js';
import type { STTProvider } from '../providers/base/stt-provider.js';
import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { VoiceEvent } from '../types/event.js';
import type { VoiceDefinition } from '../types/voice.js';
import {
  createAgentStateEvent,
  createErrorEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
} from './events.js';
import { resolveDeliveryTone } from './delivery-tone.js';
import { applyDeliveryToneToText, mapDeliveryToneForProvider } from './tone-mapper.js';
import type { TranscriptSource } from '../security/transcript-trust.js';
import { assessTranscriptTrust } from '../security/transcript-trust.js';
import { estimateVoiceTurnCost } from '../cost/estimate-voice-turn-cost.js';
import { recordProviderUsage } from './record-provider-usage.js';
import { runStreamingTurnPipeline } from './streaming-turn-pipeline.js';
import { stripVoiceAssistantMarkers } from './assistant-text.js';

export interface RunVoiceTurnArgs {
  voiceDefinition: VoiceDefinition;
  sessionId: string;
  turnId?: string;
  transcript?: string;
  transcriptSource?: TranscriptSource;
  language?: string;
  input?: Record<string, unknown>;
  sttProvider?: STTProvider;
  ttsProvider?: TTSProvider;
  transportProvider?: TransportProvider;
  cleanupProviders?: boolean;
  abortSignal?: AbortSignal;
  onEvent?: (event: VoiceEvent) => Promise<void> | void;
  onAudioChunk?: (chunk: Uint8Array) => Promise<void> | void;
  onAssistantDelta?: (delta: string) => Promise<void> | void;
}

export async function* runVoiceTurn(
  ctx: ExecutionContext,
  args: RunVoiceTurnArgs,
): AsyncIterable<VoiceEvent> {
  const voice = args.voiceDefinition;
  const turnId = args.turnId ?? randomUUID();
  const sttProvider = requireProvider(args.sttProvider, 'stt', voice.stt.provider);
  const ttsProvider = requireProvider(args.ttsProvider, 'tts', voice.tts.provider);
  const transportProvider = requireProvider(
    args.transportProvider,
    'transport',
    voice.transport.provider,
  );
  const cleanupProviders = args.cleanupProviders ?? false;

  try {
    if (args.abortSignal?.aborted) {
      return;
    }

    const budgetEstimate = estimateVoiceTurnCost({
      voice,
      estimatedResponseCharacters: args.transcript?.length
        ? Math.max(50, args.transcript.length * 2)
        : undefined,
    });
    ctx.ai.checkProviderCostBudget({ estimatedCostUsd: budgetEstimate.estimatedCostUsd });

    const hasSuppliedTranscript = Boolean(args.transcript && args.transcript.trim().length > 0);

    // Only (re)connect the STT provider when we still need to finalize server-side
    // audio ourselves. When the caller already supplied a transcript (e.g. the voice
    // session controller in continuous mode), reconnecting here would overwrite the
    // controller's onTranscript/onEndpoint callbacks on a shared provider and break
    // every turn after the first.
    if (!hasSuppliedTranscript) {
      await sttProvider.connect?.({
        sessionId: args.sessionId,
        signal: args.abortSignal,
        onTranscript: async (event) => {
          if (event.final) {
            await args.onEvent?.({
              type: 'stt.final',
              text: event.text,
              language: event.language,
              confidence: event.confidence,
            });
            return;
          }
          await args.onEvent?.({
            type: 'stt.partial',
            text: event.text,
            language: event.language,
            confidence: event.confidence,
          });
        },
      });
    }

    const finalizedTranscript = hasSuppliedTranscript ? undefined : await sttProvider.finalize?.();
    const transcriptText = finalizedTranscript?.text ?? args.transcript ?? '';
    const transcriptLanguage = finalizedTranscript?.language ?? args.language;
    const transcriptSource =
      finalizedTranscript?.text && finalizedTranscript.text.length > 0
        ? 'server-stt'
        : (args.transcriptSource ?? 'server-stt');

    yield* emit(args, createTurnStartedEvent(args.sessionId));
    yield* emit(args, createAgentStateEvent('Transcribing'));

    if (finalizedTranscript?.text) {
      yield* emit(args, {
        type: 'stt.final',
        text: finalizedTranscript.text,
        language: finalizedTranscript.language,
        confidence: finalizedTranscript.confidence,
      });
    }

    const transcript = assessTranscriptTrust(
      {
        text: transcriptText,
        source: transcriptSource,
        language: transcriptLanguage,
      },
      {},
    );
    if (!transcript.ok) {
      yield* emit(
        args,
        createTurnFailedEvent({
          sessionId: args.sessionId,
          code: 'voice.transcript_invalid',
          message: transcript.reason ?? 'Transcript is invalid',
        }),
      );
      yield* emit(args, createAgentStateEvent('Idle'));
      return;
    }

    if (!finalizedTranscript?.text) {
      yield* emit(args, {
        type: 'stt.final',
        text: transcript.text,
        language: transcript.language,
      });
    }
    yield* emit(args, createAgentStateEvent('AwaitingLLM'));

    const resolvedTone = await resolveDeliveryTone(ctx, voice, {
      userTranscript: transcript.text,
      language: transcript.language,
      sessionId: args.sessionId,
    });
    const mappedTone = mapDeliveryToneForProvider(ttsProvider, resolvedTone);

    if (mappedTone.profileId) {
      yield* emit(args, { type: 'agent.tone', profileId: mappedTone.profileId });
    }

    yield* emit(args, createAgentStateEvent('Synthesizing'));

    const useStreamingPipeline = Boolean(
      ttsProvider.capabilities.streaming && ttsProvider.synthesizeStream,
    );

    let responseText = '';
    if (useStreamingPipeline) {
      const pipelineResult = await runStreamingTurnPipeline({
        ctx,
        voice,
        sessionId: args.sessionId,
        transcriptText: transcript.text,
        ttsProvider,
        transportProvider,
        mappedTone,
        abortSignal: args.abortSignal,
        onEvent: args.onEvent,
        onAudioChunk: args.onAudioChunk,
        onAssistantDelta: args.onAssistantDelta,
        preprocessForTts: (text) => maybePreprocessForTts(ctx, voice, text),
        runBrain: async (onDelta) => runBrainWithDeltas(ctx, voice, args, transcript, onDelta),
      });
      responseText = pipelineResult.responseText;
      yield* emit(
        args,
        createTurnCompletedEvent({
          sessionId: args.sessionId,
          transcript: transcript.text,
          responseText,
        }),
      );
      yield* emit(args, createAgentStateEvent('Idle'));
    } else {
      const batchResult = await runBatchBrainAndTts({
        ctx,
        voice,
        args,
        transcript,
        ttsProvider,
        transportProvider,
        mappedTone,
      });
      responseText = batchResult.responseText;
      for (const event of batchResult.events) {
        await args.onEvent?.(event);
        yield event;
      }
    }

    if (args.abortSignal?.aborted) {
      return;
    }

    if (!responseText.trim()) {
      yield* emit(
        args,
        createTurnFailedEvent({
          sessionId: args.sessionId,
          code: 'voice.empty_response',
          message: 'Voice brain did not produce any assistant text',
        }),
      );
      yield* emit(args, createAgentStateEvent('Idle'));
      return;
    }

    if (!useStreamingPipeline) {
      yield* emit(
        args,
        createTurnCompletedEvent({
          sessionId: args.sessionId,
          transcript: transcript.text,
          responseText,
        }),
      );
      yield* emit(args, createAgentStateEvent('Idle'));
    }

    const projectId = readBrainProjectId(args.input);
    await recordProviderUsage(ctx, sttProvider, transcript.billable, {
      sessionId: args.sessionId,
      turnId,
      text: transcript.text,
      projectId,
      stt: voice.stt,
    });
    await recordProviderUsage(ctx, ttsProvider, true, {
      sessionId: args.sessionId,
      turnId,
      text: responseText,
      projectId,
      tts: voice.tts,
    });
  } catch (error) {
    if (args.abortSignal?.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown voice runtime error';
    yield* emit(args, createErrorEvent('voice.runtime_error', message));
    yield* emit(
      args,
      createTurnFailedEvent({
        sessionId: args.sessionId,
        code: 'voice.runtime_error',
        message,
      }),
    );
    yield* emit(args, createAgentStateEvent('Idle'));
  } finally {
    if (cleanupProviders) {
      await sttProvider.disconnect?.();
      await ttsProvider.flush?.();
      await transportProvider.disconnect?.();
    }
  }
}

async function runBrainWithDeltas(
  ctx: ExecutionContext,
  voice: VoiceDefinition,
  args: RunVoiceTurnArgs,
  transcript: { text: string; language?: string },
  onDelta: (delta: string) => void,
): Promise<string> {
  let deltaEmitted = false;
  const brainResult = await voice.brain.run(ctx, {
    transcript: transcript.text,
    language: transcript.language,
    sessionId: args.sessionId,
    input: args.input,
    signal: args.abortSignal,
    onAssistantDelta(delta: string) {
      if (!delta || args.abortSignal?.aborted) return;
      deltaEmitted = true;
      void onDelta(delta);
    },
  });

  if (isAsyncIterable(brainResult)) {
    let streamed = '';
    for await (const chunk of brainResult) {
      if (args.abortSignal?.aborted) break;
      if (typeof chunk === 'string' && chunk.length > 0) {
        streamed += chunk;
        deltaEmitted = true;
        await onDelta(chunk);
      }
    }
    return streamed;
  }

  const extracted = extractAssistantText(brainResult);
  if (extracted) {
    if (!deltaEmitted) {
      await onDelta(extracted);
    }
    return extracted;
  }
  return '';
}

async function runBatchBrainAndTts(args: {
  ctx: ExecutionContext;
  voice: VoiceDefinition;
  args: RunVoiceTurnArgs;
  transcript: { text: string; language?: string };
  ttsProvider: TTSProvider;
  transportProvider: TransportProvider;
  mappedTone: ReturnType<typeof mapDeliveryToneForProvider>;
}): Promise<{ responseText: string; events: VoiceEvent[] }> {
  const events: VoiceEvent[] = [];
  const pushEvent = async (event: VoiceEvent) => {
    events.push(event);
    await args.args.onEvent?.(event);
  };
  const capturedDeltas: string[] = [];
  const brainResult = await args.voice.brain.run(args.ctx, {
    transcript: args.transcript.text,
    language: args.transcript.language,
    sessionId: args.args.sessionId,
    input: args.args.input,
    signal: args.args.abortSignal,
    onAssistantDelta(delta: string) {
      if (!delta || args.args.abortSignal?.aborted) return;
      capturedDeltas.push(delta);
      void args.args.onAssistantDelta?.(delta);
    },
  });

  if (isAsyncIterable(brainResult)) {
    for await (const chunk of brainResult) {
      if (args.args.abortSignal?.aborted) break;
      if (typeof chunk === 'string' && chunk.length > 0) {
        capturedDeltas.push(chunk);
        await args.args.onAssistantDelta?.(chunk);
      }
    }
  } else if (capturedDeltas.length === 0) {
    const extracted = extractAssistantText(brainResult);
    if (extracted) capturedDeltas.push(extracted);
  }

  const responseText = stripVoiceAssistantMarkers(capturedDeltas.join(''));
  if (!responseText.trim()) {
    return { responseText: '', events };
  }

  if (args.ttsProvider.capabilities.execution === 'client') {
    await pushEvent({ type: 'tts.speak', text: responseText });
    await pushEvent(createAgentStateEvent('Playing'));
  } else if (args.ttsProvider.synthesizeStream) {
    const ttsText = applyDeliveryToneToText(args.ttsProvider, responseText, args.mappedTone.tone);
    let playingEmitted = false;
    for await (const audioChunk of args.ttsProvider.synthesizeStream(
      ttsText,
      args.mappedTone.providerParams,
      args.args.abortSignal,
    )) {
      if (args.args.abortSignal?.aborted) break;
      if (!playingEmitted) {
        await pushEvent(createAgentStateEvent('Playing'));
        playingEmitted = true;
      }
      await args.args.onAudioChunk?.(audioChunk);
      await args.transportProvider.publishAudio?.(audioChunk);
    }
  }

  return { responseText, events };
}

async function* emit(args: RunVoiceTurnArgs, event: VoiceEvent): AsyncIterable<VoiceEvent> {
  await args.onEvent?.(event);
  yield event;
}

async function maybePreprocessForTts(
  ctx: ExecutionContext,
  voice: VoiceDefinition,
  text: string,
): Promise<string> {
  if (!voice.preprocessForTts) return text;
  return voice.preprocessForTts(text, ctx);
}

function requireProvider<T>(
  provider: T | undefined,
  kind: 'stt' | 'tts' | 'transport',
  providerId: string,
): T {
  if (!provider) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Missing ${kind} provider "${providerId}" — inject a real provider via create${kind === 'stt' ? 'STT' : kind === 'tts' ? 'TTS' : 'Transport'}Provider()`,
    );
  }
  return provider;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function extractAssistantText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';

  if ('text' in result && typeof result.text === 'string') return result.text;
  if ('message' in result && typeof result.message === 'string') return result.message;
  if ('content' in result && typeof result.content === 'string') return result.content;

  return JSON.stringify(result);
}

function readBrainProjectId(input: Record<string, unknown> | undefined): string | undefined {
  const projectId = input?.projectId;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
}
