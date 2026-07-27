import type { AICostRecord } from '@plumbus/core';

export interface AICostContextLike {
  projectId?: string;
  serviceArea?: string;
  operationName?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

export type VoiceUsageKind = 'transcribe' | 'synthesize' | 'transport' | 'other';
export type VoiceCostOperation = Extract<
  AICostRecord['operation'],
  'transcribe' | 'synthesize' | 'transport'
>;

export interface VoiceMediaUsage {
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  characters?: number;
  connectionMinutes?: number;
  participantMinutes?: number;
}

export interface VoiceUsageRecord {
  provider: string;
  kind: VoiceUsageKind;
  quantity: number;
  unit: 'seconds' | 'minutes' | 'characters' | 'events' | 'unknown';
  model?: string;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordVoiceCostInput {
  operation: VoiceCostOperation;
  provider: string;
  model: string;
  mediaUsage: VoiceMediaUsage;
  latencyMs: number;
  /**
   * Optional USD override. When set, skips built-in `lookupVoicePricing` for
   * the amount (add-on packages compute their own pricing and pass it here).
   */
  cost?: number;
  costContext?: AICostContextLike;
  status?: AICostRecord['status'];
  errorMessage?: string;
}

export interface VoiceSessionBudgetConfig {
  maxConnectionMinutes?: number;
  maxParticipantMinutes?: number;
  maxAudioInputSeconds?: number;
  maxConcurrentStreams?: number;
  maxSttCharacters?: number;
  maxSessionDurationSeconds?: number;
  idleTimeoutSeconds?: number;
}

export interface VoiceSessionBudgetState {
  connectionMinutes: number;
  participantMinutes: number;
  audioInputSeconds: number;
  concurrentStreams: number;
  sttCharacters: number;
}
