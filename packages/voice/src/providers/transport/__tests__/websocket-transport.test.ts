import { describe, expect, it } from 'vitest';
import { WebSocketTransportProvider } from '../websocket-transport.js';

describe('websocket transport protocol', () => {
  it('publishes binary audio and JSON control events on the same socket', async () => {
    const sent: Array<{ binary: boolean; payload: string | Uint8Array }> = [];
    const transport = new WebSocketTransportProvider({ provider: 'websocket', mode: 'pushToTalk' });
    const socket = {
      listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
      on(event: 'message' | 'close', listener: (...args: unknown[]) => void) {
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(listener);
        this.listeners.set(event, bucket);
      },
      send(payload: string | Uint8Array, options?: { binary?: boolean }) {
        sent.push({ binary: Boolean(options?.binary), payload });
      },
      close() {},
    };

    transport.attachSocket({
      socket,
      onAudio: async () => {},
      onControl: async () => {},
    });

    transport.publishAudio(Uint8Array.from([1, 2, 3]));
    transport.sendData({ type: 'agent.state', state: 'Idle' });

    expect(sent).toEqual([
      { binary: true, payload: Uint8Array.from([1, 2, 3]) },
      { binary: false, payload: JSON.stringify({ type: 'agent.state', state: 'Idle' }) },
    ]);
  });

  it('mints websocket sessions with same-socket metadata', async () => {
    const transport = new WebSocketTransportProvider({ provider: 'websocket', mode: 'pushToTalk' });
    const session = await transport.mintSession({ voiceName: 'demo', userId: 'user-1' });
    expect(session.transport).toBe('websocket');
    expect(session.metadata).toMatchObject({ events: 'same-socket' });
  });
});
