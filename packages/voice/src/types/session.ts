export type AgentState =
  | 'Idle'
  | 'Listening'
  | 'Transcribing'
  | 'AwaitingLLM'
  | 'Synthesizing'
  | 'Playing';

export interface LiveKitVoiceClientSession {
  transport: 'livekit';
  url: string;
  token: string;
  room: string;
  audioTrackName: string;
  events: 'livekit-data';
  sttMode: 'client' | 'server';
  sessionId: string;
  audioFormat: string;
}

export interface WebSocketVoiceClientSession {
  transport: 'websocket';
  wsUrl: string;
  sessionToken: string;
  audioFormat: string;
  events: 'same-socket';
  sttMode: 'client' | 'server';
  sessionId: string;
}

export type VoiceClientSession = LiveKitVoiceClientSession | WebSocketVoiceClientSession;
