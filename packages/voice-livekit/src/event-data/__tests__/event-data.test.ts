import { describe, expect, it, vi } from 'vitest';
import {
  createVoiceEventReceiver,
  createVoiceEventSender,
  VOICE_EVENT_STREAM_TOPIC,
} from '../index.js';

describe('voice event packet and text-stream delivery', () => {
  it('uses packets for small events and native streams for a 30,000-character Hebrew transcript', async () => {
    const participant = { publishData: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    const send = createVoiceEventSender(() => participant);
    await send({ type: 'agent.state', state: 'Listening' });
    const large = { type: 'stt.final', text: 'א'.repeat(30000) };
    await send(large);
    expect(participant.publishData).toHaveBeenCalledTimes(1);
    expect(participant.sendText).toHaveBeenCalledWith(JSON.stringify(large), {
      topic: VOICE_EVENT_STREAM_TOPIC,
    });
  });

  it('keeps later packets behind the stream in both sender and receiver', async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const participant = {
      publishData: vi.fn(async () => {
        order.push('packet');
      }),
      sendText: vi.fn(async () => {
        order.push('stream');
        await gate;
      }),
    };
    const send = createVoiceEventSender(() => participant);
    const first = send({ type: 'stt.final', text: 'א'.repeat(10000) });
    const second = send({ type: 'agent.state', state: 'AwaitingLLM' });
    await vi.waitFor(() => expect(order).toEqual(['stream']));
    const events: string[] = [];
    const invalid = vi.fn();
    const receiver = createVoiceEventReceiver((data) => {
      events.push(new TextDecoder().decode(data));
    }, invalid);
    receiver.stream({
      async *[Symbol.asyncIterator]() {
        yield 'first';
        await gate;
        yield ' second';
      },
    });
    receiver.packet(new TextEncoder().encode('third'));
    expect(events).toEqual([]);
    finish();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(events).toEqual(['first second', 'third']));
    expect(order).toEqual(['stream', 'packet']);
    expect(invalid).not.toHaveBeenCalled();
    receiver.dispose();
  });

  it('bounds assembled stream bytes and continues delivering subsequent events after failure', async () => {
    const deliver = vi.fn(),
      invalid = vi.fn();
    const receiver = createVoiceEventReceiver(deliver, invalid);
    receiver.stream({
      async *[Symbol.asyncIterator]() {
        yield 'א'.repeat(140000);
      },
    });
    receiver.packet(new TextEncoder().encode('next'));
    await vi.waitFor(() => expect(invalid).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(deliver.mock.calls[0]?.[0])).toBe('next');
    receiver.dispose();
  });

  it('rejects oversized outbound events without weakening the byte bound', async () => {
    const participant = { publishData: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    await expect(
      createVoiceEventSender(() => participant)({ text: 'א'.repeat(140000) }),
    ).rejects.toThrow('256 KiB');
    expect(participant.publishData).not.toHaveBeenCalled();
    expect(participant.sendText).not.toHaveBeenCalled();
  });

  it('does not emit a late completed stream after disconnect', async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const deliver = vi.fn(),
      invalid = vi.fn();
    const receiver = createVoiceEventReceiver(deliver, invalid);
    receiver.stream({
      async *[Symbol.asyncIterator]() {
        await gate;
        yield 'late';
      },
    });
    receiver.dispose();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deliver).not.toHaveBeenCalled();
    expect(invalid).not.toHaveBeenCalled();
  });
});
