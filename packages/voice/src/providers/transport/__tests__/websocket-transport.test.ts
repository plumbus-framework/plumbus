import { describe, expect, it, vi } from 'vitest';
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

it('bounds frame sizes and pending audio before invoking callbacks', async () => {
  for (const [size, count] of [
    [65537, 1],
    [65536, 5],
    [16385, 1],
  ]) {
    let onMessage: ((raw: Buffer, binary: boolean) => void) | undefined;
    const close = vi.fn();
    const onAudio = vi.fn(async () => {});
    const onControl = vi.fn(async () => {});
    const transport = new WebSocketTransportProvider({ provider: 'websocket' });
    transport.attachSocket({
      socket: {
        on(event, listener) {
          if (event === 'message') onMessage = listener;
        },
        close,
        send() {},
      },
      onAudio,
      onControl,
    });
    for (let i = 0; i < (count ?? 0); i++) onMessage?.(Buffer.alloc(size ?? 0), size !== 16385);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledWith(1009, expect.any(String));
    expect(onAudio).not.toHaveBeenCalled();
    expect(onControl).not.toHaveBeenCalled();
  }
});

it('delivers each accepted frame once and serializes callbacks', async () => {
  let onMessage: ((raw: Buffer, binary: boolean) => void) | undefined;
  const seen: number[] = [];
  const transport = new WebSocketTransportProvider({ provider: 'websocket' });
  transport.attachSocket({
    socket: {
      on(event, listener) {
        if (event === 'message') onMessage = listener;
      },
      close() {},
      send() {},
    },
    onAudio: async (audio) => {
      seen.push(audio[0] ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(0);
    },
  });
  onMessage?.(Buffer.from([1]), true);
  onMessage?.(Buffer.from([2]), true);
  await vi.waitFor(() => expect(seen).toEqual([1, 0, 2, 0]));
});
