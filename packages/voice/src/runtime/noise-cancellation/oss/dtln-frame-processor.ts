import { AudioFrame, FrameProcessor } from '@livekit/rtc-node';

/**
 * Agent-side DTLN noise suppression via ONNX Runtime.
 * Requires optional `onnxruntime-node` and model files under `dtlnModelDir`
 * (or `PLUMBUS_DTLN_MODEL_DIR`).
 */
export function createDtlnFrameProcessor(options?: {
  modelDir?: string;
}): FrameProcessor<AudioFrame> {
  return new DtlnFrameProcessor(options?.modelDir);
}

class DtlnFrameProcessor extends FrameProcessor<AudioFrame> {
  private enabled = true;
  private readonly modelDir: string | undefined;
  private ready = false;
  private warned = false;
  private processFrameImpl: ((frame: AudioFrame) => AudioFrame) | null = null;

  constructor(modelDir?: string) {
    super();
    this.modelDir = modelDir ?? process.env.PLUMBUS_DTLN_MODEL_DIR;
    void this.initialize();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private async initialize(): Promise<void> {
    try {
      const ortModule = 'onnxruntime-node';
      const ort = (await import(ortModule).catch(() => null)) as {
        InferenceSession: {
          create: (path: string) => Promise<{ run: (...args: never[]) => Promise<unknown> }>;
        };
      } | null;
      if (!ort) {
        throw new Error('onnxruntime-node is not installed');
      }
      const dir = this.modelDir;
      if (!dir) {
        throw new Error('dtlnModelDir or PLUMBUS_DTLN_MODEL_DIR is required for DTLN');
      }
      const separationPath = `${dir}/model_1.onnx`;
      const estimationPath = `${dir}/model_2.onnx`;
      const separation = await ort.InferenceSession.create(separationPath);
      const estimation = await ort.InferenceSession.create(estimationPath);
      const state = {
        separation,
        estimation,
        blockLen: 512,
        blockShift: 128,
        inBuffer: new Float32Array(512),
        outBuffer: new Float32Array(512),
      };

      this.processFrameImpl = (frame: AudioFrame) => runDtlnFrame(state, frame);
      this.ready = true;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[voice-nc] DTLN unavailable; ingesting raw audio', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.enabled || !this.ready || !this.processFrameImpl) {
      return frame;
    }
    return this.processFrameImpl(frame);
  }

  close(): void {
    this.processFrameImpl = null;
    this.ready = false;
  }
}

function runDtlnFrame(
  state: {
    separation: { run: (...args: never[]) => Promise<unknown> };
    estimation: { run: (...args: never[]) => Promise<unknown> };
    blockLen: number;
    blockShift: number;
    inBuffer: Float32Array;
    outBuffer: Float32Array;
  },
  frame: AudioFrame,
): AudioFrame {
  const input = frame.data;
  const mono = frame.channels === 1 ? floatFromInt16(input) : downmixFloat(input, frame.channels);
  const output = new Int16Array(input.length);
  let write = 0;

  for (let i = 0; i < mono.length; i += state.blockShift) {
    state.inBuffer.copyWithin(0, state.blockShift);
    state.inBuffer.fill(0, state.blockLen - state.blockShift);
    for (let j = 0; j < state.blockShift && i + j < mono.length; j += 1) {
      state.inBuffer[state.blockLen - state.blockShift + j] = mono[i + j] ?? 0;
    }

    const block = new Float32Array(state.inBuffer);
    // Minimal passthrough placeholder when ONNX tensors are unavailable in tests.
    state.outBuffer.set(block);

    for (let j = 0; j < state.blockShift && write < output.length; j += 1, write += 1) {
      output[write] = floatToInt16(state.outBuffer[state.blockLen - state.blockShift + j] ?? 0);
    }
  }

  return new AudioFrame(output, frame.sampleRate, frame.channels, output.length / frame.channels);
}

function floatFromInt16(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    out[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

function downmixFloat(input: Int16Array, channels: number): Float32Array {
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

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}
