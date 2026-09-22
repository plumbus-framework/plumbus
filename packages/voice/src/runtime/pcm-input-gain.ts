export interface Pcm16InputGainOptions {
  inputGainDb?: number;
  targetRmsDb?: number;
  enableInputNormalization?: boolean;
  maxGainDb?: number;
}

export interface Pcm16LevelStats {
  rmsDb: number;
  peakDb: number;
}

const DEFAULT_TARGET_RMS_DB = -24;
const DEFAULT_MAX_GAIN_DB = 18;
const PEAK_LIMIT_LINEAR = 0.95;

export function analyzePcm16Levels(data: Uint8Array): Pcm16LevelStats {
  if (data.byteLength < 2) {
    return { rmsDb: -Infinity, peakDb: -Infinity };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sampleCount = Math.floor(data.byteLength / 2);
  let sumSquares = 0;
  let peak = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32_768;
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
  return {
    rmsDb: linearToDb(rms),
    peakDb: linearToDb(peak),
  };
}

export function applyPcm16InputGain(
  data: Uint8Array,
  options: Pcm16InputGainOptions = {},
): { data: Uint8Array; stats: Pcm16LevelStats; appliedGainDb: number } {
  const stats = analyzePcm16Levels(data);
  let appliedGainDb = options.inputGainDb ?? 0;

  if (options.enableInputNormalization && Number.isFinite(stats.rmsDb)) {
    const targetRmsDb = options.targetRmsDb ?? DEFAULT_TARGET_RMS_DB;
    const maxGainDb = options.maxGainDb ?? DEFAULT_MAX_GAIN_DB;
    if (stats.rmsDb < targetRmsDb) {
      const normalizationGain = Math.min(maxGainDb, targetRmsDb - stats.rmsDb);
      appliedGainDb += normalizationGain;
    }
  }

  if (appliedGainDb === 0) {
    return { data, stats, appliedGainDb: 0 };
  }

  const gainLinear = 10 ** (appliedGainDb / 20);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sampleCount = Math.floor(data.byteLength / 2);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (samples[index] ?? 0) * gainLinear;
  }

  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  }

  if (peak > PEAK_LIMIT_LINEAR && peak > 0) {
    const limiter = PEAK_LIMIT_LINEAR / peak;
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (samples[index] ?? 0) * limiter;
    }
  }

  const output = new Uint8Array(data.byteLength);
  const outputView = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    outputView.setInt16(index * 2, Math.round(clamped * 32_767), true);
  }

  return {
    data: output,
    stats: analyzePcm16Levels(output),
    appliedGainDb,
  };
}

export function resolvePcm16InputGainOptions(
  sttOptions: Record<string, unknown> | undefined,
): Pcm16InputGainOptions {
  return {
    inputGainDb: readNumberOption(sttOptions, 'inputGainDb'),
    targetRmsDb: readNumberOption(sttOptions, 'targetRmsDb'),
    enableInputNormalization: readBooleanOption(sttOptions, 'enableInputNormalization'),
    maxGainDb: readNumberOption(sttOptions, 'maxGainDb'),
  };
}

function linearToDb(value: number): number {
  if (value <= 0) {
    return -Infinity;
  }
  return 20 * Math.log10(value);
}

function readNumberOption(
  options: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = options?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBooleanOption(
  options: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = options?.[key];
  return typeof value === 'boolean' ? value : undefined;
}
