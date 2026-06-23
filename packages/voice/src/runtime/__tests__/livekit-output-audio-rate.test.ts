import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRoomTransport } from '../livekit-agent-worker.js';

const audioSourceCalls: Array<{ sampleRate: number; channels: number }> = [];
const audioFrameCalls: Array<{ sampleRate: number; channels: number }> = [];

vi.mock('@livekit/rtc-node', () => {
  class AudioSource {
    sampleRate: number;
    channels: number;
    constructor(sampleRate: number, channels: number) {
      this.sampleRate = sampleRate;
      this.channels = channels;
      audioSourceCalls.push({ sampleRate, channels });
    }
    async captureFrame() {}
  }

  class AudioFrame {
    sampleRate: number;
    channels: number;
    constructor(_data: Int16Array, sampleRate: number, channels: number, _samples: number) {
      this.sampleRate = sampleRate;
      this.channels = channels;
      audioFrameCalls.push({ sampleRate, channels });
    }
  }

  function createAudioTrack(_name: string, _source: AudioSource) {
    return {};
  }

  const LocalAudioTrack = { createAudioTrack };

  class TrackPublishOptions {}

  class FrameProcessor<T> {
    process(frame: T): T {
      return frame;
    }
  }

  class AudioStream {}

  return {
    AudioSource,
    AudioFrame,
    LocalAudioTrack,
    TrackPublishOptions,
    FrameProcessor,
    AudioStream,
    RoomEvent: {},
    TrackKind: { KIND_AUDIO: 1 },
  };
});

describe('createRoomTransport output audio rate', () => {
  it('uses outputAudioFormat for the agent track while keeping mic format separate', async () => {
    audioSourceCalls.length = 0;
    audioFrameCalls.length = 0;

    const room = new EventEmitter() as EventEmitter & {
      localParticipant?: { publishTrack: () => Promise<void> };
    };
    room.localParticipant = { publishTrack: async () => {} };

    const transport = createRoomTransport(
      room as never,
      'pcm16-16k',
      'agent-voice',
      'pcm16;rate=48000;channels=1',
    );

    await transport.publishAudio?.(new Uint8Array(960));

    expect(audioSourceCalls).toEqual([{ sampleRate: 48000, channels: 1 }]);
    expect(audioFrameCalls).toEqual([{ sampleRate: 48000, channels: 1 }]);
  });

  it('defaults output rate to the transport audioFormat when outputAudioFormat is omitted', async () => {
    audioSourceCalls.length = 0;
    audioFrameCalls.length = 0;

    const room = new EventEmitter() as EventEmitter & {
      localParticipant?: { publishTrack: () => Promise<void> };
    };
    room.localParticipant = { publishTrack: async () => {} };

    const transport = createRoomTransport(room as never, 'pcm16-16k', 'agent-voice');

    await transport.publishAudio?.(new Uint8Array(640));

    expect(audioSourceCalls).toEqual([{ sampleRate: 16000, channels: 1 }]);
    expect(audioFrameCalls).toEqual([{ sampleRate: 16000, channels: 1 }]);
  });
});
