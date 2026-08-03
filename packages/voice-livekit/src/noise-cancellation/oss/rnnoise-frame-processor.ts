import { AudioFrame, FrameProcessor } from '@livekit/rtc-node';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { type DenoiseState, Rnnoise } from '@shiguredo/rnnoise-wasm';

const RNNOISE_SAMPLE_RATE = 48_000;

let rnnoiseFactoryPromise: Promise<Rnnoise | null> | undefined;

async function loadRnnoiseFactory(): Promise<Rnnoise | null> {
  if (!rnnoiseFactoryPromise) {
    rnnoiseFactoryPromise = Rnnoise.load().catch(() => null);
  }
  return rnnoiseFactoryPromise;
}

class RnnoiseFrameProcessor extends FrameProcessor<AudioFrame> {
  private enabled = true;
  private denoiseState: DenoiseState | null = null;
  private frameSize = 480;
  private pending = new Float32Array(0);
  private initPromise: Promise<void>;

  constructor() {
    super();
    this.initPromise = this.ensureReady().catch(() => undefined);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private async ensureReady(): Promise<void> {
    if (this.denoiseState) return;
    const factory = await loadRnnoiseFactory();
    if (!factory) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        '@shiguredo/rnnoise-wasm failed to load',
      );
    }
    this.frameSize = factory.frameSize;
    this.denoiseState = factory.createDenoiseState();
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.enabled || !this.denoiseState) {
      void this.initPromise;
      return frame;
    }

    const input = resampleTo48kMonoFloat(frame);
    const merged = concatFloat32(this.pending, input);
    const output = new Float32Array(merged.length);
    let writeIndex = 0;

    for (let offset = 0; offset + this.frameSize <= merged.length; offset += this.frameSize) {
      const chunk = merged.subarray(offset, offset + this.frameSize);
      const working = new Float32Array(chunk);
      this.denoiseState.processFrame(working);
      output.set(working, writeIndex);
      writeIndex += this.frameSize;
    }

    const consumed = Math.floor(merged.length / this.frameSize) * this.frameSize;
    this.pending =
      consumed < merged.length ? new Float32Array(merged.subarray(consumed)) : new Float32Array(0);

    const processed = output.subarray(0, writeIndex);
    if (processed.length === 0) {
      return frame;
    }

    return downsampleFloatToFrame(processed, frame);
  }

  close(): void {
    this.denoiseState?.destroy();
    this.denoiseState = null;
    this.pending = new Float32Array(0);
  }
}

export function createRnnoiseFrameProcessor(_options?: {
  lite?: boolean;
}): FrameProcessor<AudioFrame> {
  return new RnnoiseFrameProcessor();
}

function resampleTo48kMonoFloat(frame: AudioFrame): Float32Array {
  const input = frame.data;
  const mono =
    frame.channels === 1 ? int16ToFloat(input) : downmixInt16ToFloat(input, frame.channels);

  if (frame.sampleRate === RNNOISE_SAMPLE_RATE) {
    return mono;
  }

  const ratio = RNNOISE_SAMPLE_RATE / frame.sampleRate;
  const outputLength = Math.max(1, Math.round(mono.length * ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = Math.min(mono.length - 1, Math.floor(i / ratio));
    output[i] = mono[sourceIndex] ?? 0;
  }
  return output;
}

function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    out[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

function downmixInt16ToFloat(input: Int16Array, channels: number): Float32Array {
  const frames = Math.floor(input.length / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += input[i * channels + ch] ?? 0;
    }
    mono[i] = sum / channels / 0x8000;
  }
  return mono;
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const merged = new Float32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function downsampleFloatToFrame(processed48k: Float32Array, original: AudioFrame): AudioFrame {
  if (original.sampleRate === RNNOISE_SAMPLE_RATE && original.channels === 1) {
    const pcm = floatToInt16(processed48k);
    return new AudioFrame(pcm, original.sampleRate, original.channels, pcm.length);
  }

  const ratio = original.sampleRate / RNNOISE_SAMPLE_RATE;
  const frames = Math.max(1, Math.round(processed48k.length * ratio));
  const output = new Int16Array(frames * original.channels);
  for (let i = 0; i < frames; i += 1) {
    const sourceIndex = Math.min(processed48k.length - 1, Math.floor(i / ratio));
    const sample = floatToInt16Scalar(processed48k[sourceIndex] ?? 0);
    for (let ch = 0; ch < original.channels; ch += 1) {
      output[i * original.channels + ch] = sample;
    }
  }
  return new AudioFrame(output, original.sampleRate, original.channels, frames);
}

function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = floatToInt16Scalar(input[i] ?? 0);
  }
  return output;
}

function floatToInt16Scalar(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/** Client RNNoise track processor — not yet wired; agent path is supported. */
export async function createClientRnnoiseTrackProcessor(_options?: {
  lite?: boolean;
}): Promise<null> {
  return null;
}
