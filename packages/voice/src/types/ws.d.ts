declare module 'ws' {
  class WebSocket {
    constructor(url: string, options?: { headers?: Record<string, string> });
    send(data: string | Uint8Array | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
  }

  namespace WebSocket {
    type RawData = Buffer | ArrayBuffer | Buffer[];
  }

  export default WebSocket;
}
