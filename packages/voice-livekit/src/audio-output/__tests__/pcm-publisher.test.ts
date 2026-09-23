import { describe, expect, it } from 'vitest';
import { createPcmAudioPublisher } from '../index.js';

describe('LiveKit PCM output framing', () => {
  it.each([
    16000, 48000,
  ])('never hands the native queue a multi-second frame (%i Hz)', async (sampleRate) => {
    const original = Int16Array.from({ length: sampleRate * 3 }, (_, i) => (i % 60000) - 30000);
    const received: number[] = [];
    const publisher = createPcmAudioPublisher({ sampleRate, channels: 1 }, async (frame) => {
      // Real AudioSource capture can hang when one frame exceeds its queue capacity.
      expect(frame.samplesPerChannel / frame.sampleRate).toBeLessThanOrEqual(0.02);
      expect(frame.data.byteOffset).toBe(0);
      expect(frame.data.buffer.byteLength).toBe(frame.data.byteLength);
      // Match rtc-node's native pointer marshalling, which starts at buffer offset zero.
      received.push(
        ...new Int16Array(frame.data.buffer, 0, frame.samplesPerChannel * frame.channels),
      );
    });
    await publisher.publish(new Uint8Array(original.buffer));
    expect(Int16Array.from(received)).toEqual(original);
  });
  it('preserves channel alignment and byte order across odd network boundaries and concurrent writes', async () => {
    const samples = new Int16Array([256, -200, 32767, -32768, 40, 50]);
    const bytes = new Uint8Array(samples.buffer);
    const received: number[] = [];
    const publisher = createPcmAudioPublisher({ sampleRate: 48000, channels: 2 }, async (frame) => {
      expect(frame.samplesPerChannel).toBe(frame.data.length / 2);
      received.push(...frame.data);
    });
    await Promise.all([
      publisher.publish(bytes.subarray(0, 3)),
      publisher.publish(bytes.subarray(3, 7)),
      publisher.publish(bytes.subarray(7)),
    ]);
    expect(Int16Array.from(received)).toEqual(samples);
  });
  it('discards partial samples from a disconnected stream', async () => {
    const received: number[] = [];
    const publisher = createPcmAudioPublisher({ sampleRate: 16000, channels: 1 }, async (frame) => {
      received.push(...frame.data);
    });
    await publisher.publish(new Uint8Array([123]));
    publisher.reset();
    await publisher.publish(new Uint8Array([1, 0]));
    expect(received).toEqual([1]);
  });
});
