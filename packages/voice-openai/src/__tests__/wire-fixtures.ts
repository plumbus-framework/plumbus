import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export interface RecordedWsConnection {
  headers: Record<string, string | string[] | undefined>;
  messages: Array<{ binary: boolean; text?: string; data: Uint8Array }>;
  url: string;
}

export async function createWsFixture(pathname = '/'): Promise<{
  connections: RecordedWsConnection[];
  close(): Promise<void>;
  createWebSocket(url: string, init?: { headers?: Record<string, string> }): WebSocket;
  onConnection(handler: (socket: WebSocket, record: RecordedWsConnection) => void): void;
  url: string;
}> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const connections: RecordedWsConnection[] = [];
  const listeners: Array<(socket: WebSocket, record: RecordedWsConnection) => void> = [];

  wss.on('connection', (socket, request) => {
    const record: RecordedWsConnection = {
      headers: request.headers,
      messages: [],
      url: request.url ?? '/',
    };
    connections.push(record);
    socket.on('message', (data, isBinary) => {
      const bytes = toUint8Array(data);
      record.messages.push({
        binary: isBinary,
        data: bytes,
        text: isBinary ? undefined : Buffer.from(bytes).toString('utf-8'),
      });
    });
    for (const listener of listeners) {
      listener(socket, record);
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine websocket fixture address');
  }

  return {
    connections,
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      server.close();
      await once(server, 'close');
    },
    createWebSocket(url, init) {
      return new WebSocket(url, { headers: init?.headers });
    },
    onConnection(handler) {
      listeners.push(handler);
    },
    url: `ws://127.0.0.1:${address.port}${pathname}`,
  };
}

export function toJsonMessages(record: RecordedWsConnection): unknown[] {
  return record.messages
    .filter((message) => !message.binary && message.text)
    .map((message) => JSON.parse(message.text ?? '{}'));
}

export function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (typeof data === 'string') {
    return Uint8Array.from(Buffer.from(data, 'utf-8'));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data.map((item) => Buffer.from(item))));
  }
  return new Uint8Array(data);
}
