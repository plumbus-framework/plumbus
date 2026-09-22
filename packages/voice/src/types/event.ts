import type { AgentState } from './session.js';
import type { ToneProfileId } from './voice.js';

export type VoiceEvent =
  | {
      type: 'session.hello';
      sessionId: string;
      transport: string;
      audioFormat: string;
      sttMode: 'client' | 'server';
    }
  | { type: 'session.ready'; sessionId: string; transport: string }
  | { type: 'stt.partial'; text: string; language?: string; confidence?: number }
  | { type: 'stt.final'; text: string; language?: string; confidence?: number }
  | { type: 'agent.state'; state: AgentState }
  | { type: 'agent.tone'; profileId?: ToneProfileId }
  | { type: 'assistant.delta'; text: string }
  | { type: 'tts.speak'; text: string }
  | { type: 'turn.started'; sessionId: string }
  | { type: 'turn.completed'; sessionId: string; transcript?: string; responseText?: string }
  | { type: 'turn.interrupted'; sessionId: string; reason?: string }
  | { type: 'turn.failed'; sessionId: string; code: string; message: string }
  | { type: 'error'; code: string; message: string };
