import type { VoiceUsageRecord } from '../../types/cost.js';
import type { DeliveryTone } from '../../types/voice.js';
import type { TTSProviderCapabilities } from './capabilities.js';

export interface TTSProvider {
  readonly capabilities: TTSProviderCapabilities;
  mapDeliveryTone(tone: DeliveryTone): unknown;
  applyDeliveryToText?(text: string, tone: DeliveryTone): string;
  synthesizeStream?(text: string, params: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  abortGeneration?(generationId: string): void | Promise<void>;
  abortAll?(): void | Promise<void>;
  flush?(): Promise<void> | void;
  usage?(): VoiceUsageRecord[];
}
