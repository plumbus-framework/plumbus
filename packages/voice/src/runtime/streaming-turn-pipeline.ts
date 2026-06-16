import type { ExecutionContext } from '@plumbus/core';
import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { TransportProvider } from '../providers/base/transport-provider.js';
import type { VoiceEvent } from '../types/event.js';
import type { VoiceDefinition } from '../types/voice.js';
import { stripVoiceAssistantMarkers } from './assistant-text.js';
import { createAgentStateEvent } from './events.js';
import { createSentenceChunker } from './sentence-chunker.js';
import { applyDeliveryToneToText } from './tone-mapper.js';
import type { MappedDeliveryTone } from './tone-mapper.js';

export interface StreamingTurnPipelineArgs {
  ctx: ExecutionContext;
  voice: VoiceDefinition;
  sessionId: string;
  transcriptText: string;
  ttsProvider: TTSProvider;
  transportProvider: TransportProvider;
  mappedTone: MappedDeliveryTone;
  abortSignal?: AbortSignal;
  onEvent?: (event: VoiceEvent) => Promise<void> | void;
  onAudioChunk?: (chunk: Uint8Array) => Promise<void> | void;
  onAssistantDelta?: (delta: string) => Promise<void> | void;
  runBrain: (onDelta: (delta: string) => void) => Promise<string>;
  preprocessForTts?: (text: string) => Promise<string>;
}

export async function runStreamingTurnPipeline(
  args: StreamingTurnPipelineArgs,
): Promise<{ responseText: string }> {
  const chunker = createSentenceChunker();
  const utteranceQueue: string[] = [];
  let utteranceWaiters: Array<() => void> = [];
  let brainDone = false;
  let brainError: Error | undefined;
  let playingEmitted = false;
  const capturedDeltas: string[] = [];

  const notifyUtterance = () => {
    const waiter = utteranceWaiters.shift();
    waiter?.();
  };

  const enqueueUtterances = (utterances: string[]) => {
    if (utterances.length === 0) return;
    utteranceQueue.push(...utterances);
    notifyUtterance();
  };

  const nextUtterance = async (): Promise<string | undefined> => {
    while (utteranceQueue.length === 0) {
      if (brainError) throw brainError;
      if (brainDone) return undefined;
      if (args.abortSignal?.aborted) return undefined;
      await new Promise<void>((resolve) => {
        utteranceWaiters.push(resolve);
      });
    }
    return utteranceQueue.shift();
  };

  const brainPromise = args
    .runBrain((delta) => {
      if (!delta || args.abortSignal?.aborted) return;
      capturedDeltas.push(delta);
      void args.onAssistantDelta?.(delta);
      const cleaned = stripVoiceAssistantMarkers(delta);
      if (!cleaned) return;
      enqueueUtterances(chunker.push(cleaned));
    })
    .then((responseText) => {
      enqueueUtterances(chunker.flush());
      brainDone = true;
      notifyUtterance();
      return responseText;
    })
    .catch((error: unknown) => {
      brainError = error instanceof Error ? error : new Error('Voice brain failed');
      brainDone = true;
      notifyUtterance();
      throw brainError;
    });

  const ttsPromise = (async () => {
    while (!args.abortSignal?.aborted) {
      const utterance = await nextUtterance();
      if (!utterance) break;

      const preprocessed = args.preprocessForTts
        ? await args.preprocessForTts(utterance)
        : utterance;
      const ttsText = applyDeliveryToneToText(args.ttsProvider, preprocessed, args.mappedTone.tone);

      if (args.ttsProvider.capabilities.execution === 'client') {
        await args.onEvent?.({ type: 'tts.speak', text: ttsText });
        if (!playingEmitted) {
          await args.onEvent?.(createAgentStateEvent('Playing'));
          playingEmitted = true;
        }
        continue;
      }

      if (!args.ttsProvider.synthesizeStream) continue;

      for await (const audioChunk of args.ttsProvider.synthesizeStream(
        ttsText,
        args.mappedTone.providerParams,
        args.abortSignal,
      )) {
        if (args.abortSignal?.aborted) return;
        if (!playingEmitted) {
          await args.onEvent?.(createAgentStateEvent('Playing'));
          playingEmitted = true;
        }
        await args.onAudioChunk?.(audioChunk);
        await args.transportProvider.publishAudio?.(audioChunk);
      }
    }
  })();

  const responseText = await brainPromise;
  await ttsPromise;

  if (args.abortSignal?.aborted) {
    return { responseText: capturedDeltas.join('') || responseText };
  }

  const finalText = capturedDeltas.join('') || responseText;
  return { responseText: finalText };
}
