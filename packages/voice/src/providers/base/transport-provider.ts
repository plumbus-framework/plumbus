export interface TransportProviderSession {
  sessionId: string;
  transport: string;
  metadata?: Record<string, unknown>;
}

export interface TransportProviderMintSessionArgs {
  voiceName: string;
  userId?: string;
  sessionId?: string;
  roomName?: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, string>;
  tokenTtlSeconds?: number;
  identity?: string;
}

export interface TransportProvider {
  mintSession(args: TransportProviderMintSessionArgs): Promise<TransportProviderSession>;
  publishAudio?(audio: Uint8Array): Promise<void> | void;
  subscribeRemote?(onAudio: (audio: Uint8Array) => Promise<void> | void): Promise<void> | void;
  sendData?(payload: unknown): Promise<void> | void;
  disconnect?(): Promise<void> | void;
}
