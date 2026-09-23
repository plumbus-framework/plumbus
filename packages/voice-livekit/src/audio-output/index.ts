/** Frame provider PCM into bounded LiveKit captures without changing audio samples. */
import { AudioFrame } from '@livekit/rtc-node';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export function createPcmAudioPublisher(
  format: { sampleRate: number; channels: number },
  capture: (frame: AudioFrame) => Promise<void>,
) {
  const parsed = z
    .object({
      sampleRate: z.number().int().positive().max(384000),
      channels: z.number().int().positive().max(32),
    })
    .safeParse(format);
  if (!parsed.success) throw new PlumbusError(ErrorCode.Validation, 'Invalid PCM output format');
  const bytesPerSampleFrame = 2 * format.channels;
  const maxSamplesPerChannel = Math.max(1, Math.floor(format.sampleRate / 50));
  let remainder = new Uint8Array(0);
  let queue = Promise.resolve();
  let generation = 0;
  return {
    publish(audio: Uint8Array): Promise<void> {
      const incoming = audio.slice();
      const current = generation;
      const task = queue.then(async () => {
        if (current !== generation) return;
        const bytes = new Uint8Array(remainder.length + incoming.length);
        bytes.set(remainder);
        bytes.set(incoming, remainder.length);
        const completeBytes = bytes.length - (bytes.length % bytesPerSampleFrame);
        remainder = bytes.slice(completeBytes);
        const view = new DataView(bytes.buffer, 0, completeBytes);
        const samples = new Int16Array(completeBytes / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
        const maxInterleavedSamples = maxSamplesPerChannel * format.channels;
        for (let offset = 0; offset < samples.length; offset += maxInterleavedSamples) {
          if (current !== generation) return;
          // rtc-node marshals data.buffer from offset zero; each frame must own its buffer.
          const data = samples.slice(
            offset,
            Math.min(offset + maxInterleavedSamples, samples.length),
          );
          await capture(
            new AudioFrame(data, format.sampleRate, format.channels, data.length / format.channels),
          );
        }
      });
      queue = task.catch(() => {});
      return task;
    },
    reset(): void {
      generation += 1;
      remainder = new Uint8Array(0);
    },
  };
}
