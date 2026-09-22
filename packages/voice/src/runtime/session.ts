import type { AgentState } from '../types/session.js';
import { createAgentStateEvent, createSessionHelloEvent } from './events.js';

export interface VoiceRuntimeSession {
  id: string;
  voiceName: string;
  transport: string;
  audioFormat: string;
  state: AgentState;
  userId?: string;
  createdAt: Date;
  lastUpdatedAt: Date;
}

export function createVoiceRuntimeSession(args: {
  id: string;
  voiceName: string;
  transport: string;
  audioFormat?: string;
  userId?: string;
  now?: Date;
}): VoiceRuntimeSession {
  const now = args.now ?? new Date();
  return {
    id: args.id,
    voiceName: args.voiceName,
    transport: args.transport,
    audioFormat: args.audioFormat ?? 'pcm16;rate=16000;channels=1',
    state: 'Idle',
    userId: args.userId,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

export function setVoiceSessionState(
  session: VoiceRuntimeSession,
  state: AgentState,
): VoiceRuntimeSession {
  session.state = state;
  session.lastUpdatedAt = new Date();
  return session;
}

export function toVoiceSessionHello(
  session: VoiceRuntimeSession,
  sttMode: 'client' | 'server' = 'server',
) {
  return createSessionHelloEvent({
    sessionId: session.id,
    transport: session.transport,
    audioFormat: session.audioFormat,
    sttMode,
  });
}

export function toVoiceSessionStateEvent(session: VoiceRuntimeSession) {
  return createAgentStateEvent(session.state);
}
