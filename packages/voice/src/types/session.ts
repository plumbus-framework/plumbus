export type AgentState =
  | 'Idle'
  | 'Listening'
  | 'Transcribing'
  | 'AwaitingLLM'
  | 'Synthesizing'
  | 'Playing';

/** Generic room-transport client session payload (shape from `/token` + mintSession). */
export interface RoomVoiceClientSession {
  transport: string;
  url: string;
  token: string;
  room: string;
  audioTrackName: string;
  events: string;
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

export type VoiceClientSession = RoomVoiceClientSession | WebSocketVoiceClientSession;
