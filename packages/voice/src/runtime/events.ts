import type { AgentState } from '../types/session.js';
import type { VoiceEvent } from '../types/event.js';

export function createAgentStateEvent(state: AgentState): VoiceEvent {
  return { type: 'agent.state', state };
}

export function createSessionHelloEvent(args: {
  sessionId: string;
  transport: 'livekit' | 'websocket';
  audioFormat: string;
  sttMode?: 'client' | 'server';
}): VoiceEvent {
  return {
    type: 'session.hello',
    sessionId: args.sessionId,
    transport: args.transport,
    audioFormat: args.audioFormat,
    sttMode: args.sttMode ?? 'server',
  };
}

export function createTurnStartedEvent(sessionId: string): VoiceEvent {
  return { type: 'turn.started', sessionId };
}

export function createTurnCompletedEvent(args: {
  sessionId: string;
  transcript?: string;
  responseText?: string;
}): VoiceEvent {
  return {
    type: 'turn.completed',
    sessionId: args.sessionId,
    transcript: args.transcript,
    responseText: args.responseText,
  };
}

export function createTurnFailedEvent(args: {
  sessionId: string;
  code: string;
  message: string;
}): VoiceEvent {
  return {
    type: 'turn.failed',
    sessionId: args.sessionId,
    code: args.code,
    message: args.message,
  };
}

export function createErrorEvent(code: string, message: string): VoiceEvent {
  return { type: 'error', code, message };
}
