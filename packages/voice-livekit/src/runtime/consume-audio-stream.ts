import type { AudioFrame, AudioStream } from '@livekit/rtc-node';

export async function consumeAudioStream(
  stream: AudioStream,
  onFrame: (frame: AudioFrame) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await onFrame(value);
    }
  } finally {
    reader.releaseLock();
  }
}
