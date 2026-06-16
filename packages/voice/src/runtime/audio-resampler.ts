export interface AudioFrame {
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  format?: 'pcm16';
}

export interface AudioFormatSpec {
  sampleRate: number;
  channels: number;
  format?: 'pcm16';
}

export function normalizeAudioFrame(frame: AudioFrame, target: AudioFormatSpec): AudioFrame {
  if (
    frame.sampleRate === target.sampleRate &&
    frame.channels === target.channels &&
    (frame.format ?? 'pcm16') === (target.format ?? 'pcm16')
  ) {
    return frame;
  }

  const resampled = resamplePcm16(frame.data, frame, target);
  return {
    data: resampled,
    sampleRate: target.sampleRate,
    channels: target.channels,
    format: target.format ?? 'pcm16',
  };
}

export function resamplePcm16(
  audio: Uint8Array,
  source: AudioFormatSpec,
  target: AudioFormatSpec,
): Uint8Array {
  if (
    source.sampleRate === target.sampleRate &&
    source.channels === target.channels
  ) {
    return audio;
  }

  let samples = bytesToSamples(audio, source.channels);
  if (source.sampleRate !== target.sampleRate) {
    samples = linearResample(samples, source.sampleRate, target.sampleRate, source.channels);
  }
  if (source.channels !== target.channels) {
    samples = convertChannels(samples, source.channels, target.channels);
  }
  return samplesToBytes(samples);
}

export function parseAudioFormatSpec(contentType: string | undefined): AudioFormatSpec {
  const normalized = (contentType ?? 'pcm16;rate=16000;channels=1').toLowerCase();
  if (normalized === 'pcm16-16k') {
    return { sampleRate: 16_000, channels: 1, format: 'pcm16' };
  }
  if (normalized === 'pcm16-24k') {
    return { sampleRate: 24_000, channels: 1, format: 'pcm16' };
  }

  const rateMatch = normalized.match(/rate=(\d+)/);
  const channelsMatch = normalized.match(/channels=(\d+)/);
  return {
    sampleRate: Number(rateMatch?.[1] ?? 16_000),
    channels: Number(channelsMatch?.[1] ?? 1),
    format: 'pcm16',
  };
}

export function audioFormatToWireValue(format: AudioFormatSpec): string {
  return `${format.format ?? 'pcm16'};rate=${format.sampleRate};channels=${format.channels}`;
}

function bytesToSamples(audio: Uint8Array, channels: number): Float32Array {
  const sampleCount = Math.floor(audio.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  if (channels <= 1) {
    return samples;
  }

  const frames = Math.floor(sampleCount / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel] ?? 0;
    }
    mono[frame] = sum / channels;
  }
  return mono;
}

function samplesToBytes(samples: Float32Array): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, Math.round(clamped * 32_767), true);
  }
  return output;
}

function linearResample(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
  channels: number,
): Float32Array {
  if (sourceRate === targetRate) {
    return samples;
  }

  const frameCount = Math.max(1, Math.floor(samples.length / Math.max(1, channels)));
  const outputFrames = Math.max(1, Math.round((frameCount * targetRate) / sourceRate));
  const output = new Float32Array(outputFrames * channels);
  const ratio = (frameCount - 1) / Math.max(1, outputFrames - 1);

  for (let outFrame = 0; outFrame < outputFrames; outFrame += 1) {
    const sourcePosition = outFrame * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(frameCount - 1, leftIndex + 1);
    const weight = sourcePosition - leftIndex;

    for (let channel = 0; channel < channels; channel += 1) {
      const left = samples[leftIndex * channels + channel] ?? 0;
      const right = samples[rightIndex * channels + channel] ?? 0;
      output[outFrame * channels + channel] = left + (right - left) * weight;
    }
  }

  return output;
}

function convertChannels(samples: Float32Array, sourceChannels: number, targetChannels: number): Float32Array {
  if (sourceChannels === targetChannels) {
    return samples;
  }

  const frameCount = Math.floor(samples.length / Math.max(1, sourceChannels));
  const output = new Float32Array(frameCount * targetChannels);

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (targetChannels === 1 && sourceChannels > 1) {
      let sum = 0;
      for (let channel = 0; channel < sourceChannels; channel += 1) {
        sum += samples[frame * sourceChannels + channel] ?? 0;
      }
      output[frame] = sum / sourceChannels;
      continue;
    }

    for (let channel = 0; channel < targetChannels; channel += 1) {
      output[frame * targetChannels + channel] =
        samples[frame * sourceChannels + Math.min(channel, sourceChannels - 1)] ?? 0;
    }
  }

  return output;
}
