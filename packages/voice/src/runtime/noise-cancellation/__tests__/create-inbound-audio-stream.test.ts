import { describe, expect, it, vi } from 'vitest';
import { parseNoiseCancellation } from '../parse-noise-cancellation.js';

const audioStreamMock = vi.fn();

vi.mock('@livekit/rtc-node', async () => {
  const actual = await vi.importActual<typeof import('@livekit/rtc-node')>('@livekit/rtc-node');
  return {
    ...actual,
    AudioStream: audioStreamMock,
  };
});

vi.mock('../resolve-noise-cancellation.js', () => ({
  resolveAgentNoiseCancellationOption: vi.fn(() => ({ moduleId: 'bvc', options: {} })),
}));

describe('createInboundAudioStream', () => {
  it('passes noiseCancellation to AudioStream for agent Krisp config', async () => {
    audioStreamMock.mockReset();
    audioStreamMock.mockReturnValue({ getReader: vi.fn() });

    const { createInboundAudioStream } = await import('../create-inbound-audio-stream.js');
    const track = {} as never;
    const config = parseNoiseCancellation({
      placement: 'agent',
      engine: 'krisp',
      model: 'bvc',
    });

    createInboundAudioStream(track, { sampleRate: 16000, channels: 1 }, config);

    expect(audioStreamMock).toHaveBeenCalledWith(track, {
      sampleRate: 16000,
      numChannels: 1,
      noiseCancellation: { moduleId: 'bvc', options: {} },
    });
  });
});
