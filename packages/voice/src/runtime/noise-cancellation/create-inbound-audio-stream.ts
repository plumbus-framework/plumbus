import { AudioStream, type RemoteTrack } from '@livekit/rtc-node';
import type { ResolvedNoiseCancellation } from '../../types/noise-cancellation.js';
import { resolveAgentNoiseCancellationOption } from './resolve-noise-cancellation.js';

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  frameSizeMs?: number;
}

export function createInboundAudioStream(
  track: RemoteTrack,
  format: PcmFormat,
  noiseCancellation: ResolvedNoiseCancellation,
): AudioStream {
  const ncOption = resolveAgentNoiseCancellationOption(noiseCancellation);
  const options = {
    sampleRate: format.sampleRate,
    numChannels: format.channels,
    ...(format.frameSizeMs !== undefined ? { frameSizeMs: format.frameSizeMs } : {}),
    ...(ncOption ? { noiseCancellation: ncOption } : {}),
  };
  return new AudioStream(track, options);
}
