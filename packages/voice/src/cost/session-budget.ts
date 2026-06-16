import type {
  VoiceMediaUsage,
  VoiceSessionBudgetConfig,
  VoiceSessionBudgetState,
} from '../types/cost.js';

export interface VoiceSessionBudgetCheck {
  allowed: boolean;
  reason?: string;
}

export interface VoiceSessionBudget {
  readonly config: VoiceSessionBudgetConfig;
  readonly state: Readonly<VoiceSessionBudgetState>;
  check(nextUsage?: Partial<VoiceMediaUsage> & { concurrentStreams?: number; sttCharacters?: number }): VoiceSessionBudgetCheck;
  record(usage: Partial<VoiceMediaUsage> & { concurrentStreams?: number; sttCharacters?: number }): VoiceSessionBudgetState;
}

export function createVoiceSessionBudget(config: VoiceSessionBudgetConfig = {}): VoiceSessionBudget {
  const state: VoiceSessionBudgetState = {
    connectionMinutes: 0,
    participantMinutes: 0,
    audioInputSeconds: 0,
    concurrentStreams: 0,
    sttCharacters: 0,
  };

  return {
    config,
    get state() {
      return { ...state };
    },
    check(nextUsage = {}) {
      const nextState = mergeUsage(state, nextUsage);

      if (
        config.maxConnectionMinutes !== undefined &&
        nextState.connectionMinutes > config.maxConnectionMinutes
      ) {
        return {
          allowed: false,
          reason: `Voice session exceeded connection minute cap (${config.maxConnectionMinutes}).`,
        };
      }

      if (
        config.maxParticipantMinutes !== undefined &&
        nextState.participantMinutes > config.maxParticipantMinutes
      ) {
        return {
          allowed: false,
          reason: `Voice session exceeded participant minute cap (${config.maxParticipantMinutes}).`,
        };
      }

      if (
        config.maxAudioInputSeconds !== undefined &&
        nextState.audioInputSeconds > config.maxAudioInputSeconds
      ) {
        return {
          allowed: false,
          reason: `Voice session exceeded audio input cap (${config.maxAudioInputSeconds}).`,
        };
      }

      if (
        config.maxConcurrentStreams !== undefined &&
        nextState.concurrentStreams > config.maxConcurrentStreams
      ) {
        return {
          allowed: false,
          reason: `Voice session exceeded concurrent stream cap (${config.maxConcurrentStreams}).`,
        };
      }

      if (
        config.maxSttCharacters !== undefined &&
        nextState.sttCharacters > config.maxSttCharacters
      ) {
        return {
          allowed: false,
          reason: `Voice session exceeded STT character cap (${config.maxSttCharacters}).`,
        };
      }

      return { allowed: true };
    },
    record(usage) {
      const nextState = mergeUsage(state, usage);
      state.connectionMinutes = nextState.connectionMinutes;
      state.participantMinutes = nextState.participantMinutes;
      state.audioInputSeconds = nextState.audioInputSeconds;
      state.concurrentStreams = nextState.concurrentStreams;
      state.sttCharacters = nextState.sttCharacters;
      return { ...state };
    },
  };
}

function mergeUsage(
  current: VoiceSessionBudgetState,
  next: Partial<VoiceMediaUsage> & { concurrentStreams?: number; sttCharacters?: number },
): VoiceSessionBudgetState {
  return {
    connectionMinutes: current.connectionMinutes + (next.connectionMinutes ?? 0),
    participantMinutes: current.participantMinutes + (next.participantMinutes ?? 0),
    audioInputSeconds: current.audioInputSeconds + (next.audioInputSeconds ?? 0),
    concurrentStreams: Math.max(current.concurrentStreams, next.concurrentStreams ?? 0),
    sttCharacters: current.sttCharacters + (next.sttCharacters ?? 0),
  };
}
