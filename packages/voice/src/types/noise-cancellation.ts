export const NoiseCancellationPlacement = {
  Off: 'off',
  Client: 'client',
  Agent: 'agent',
} as const;

export type NoiseCancellationPlacement =
  (typeof NoiseCancellationPlacement)[keyof typeof NoiseCancellationPlacement];

export const NoiseCancellationEngine = {
  Krisp: 'krisp',
  Dtln: 'dtln',
  Rnnoise: 'rnnoise',
} as const;

export type NoiseCancellationEngine =
  (typeof NoiseCancellationEngine)[keyof typeof NoiseCancellationEngine];

export const NoiseCancellationModel = {
  Standard: 'standard',
  Bvc: 'bvc',
  Lite: 'lite',
} as const;

export type NoiseCancellationModel =
  (typeof NoiseCancellationModel)[keyof typeof NoiseCancellationModel];

export interface VoiceNoiseCancellationConfig {
  placement: NoiseCancellationPlacement;
  engine?: NoiseCancellationEngine;
  model?: NoiseCancellationModel;
  /** Optional directory with DTLN ONNX model files (agent dtln only). */
  dtlnModelDir?: string;
}

export interface ResolvedNoiseCancellation {
  placement: NoiseCancellationPlacement;
  engine: NoiseCancellationEngine | 'none';
  model: NoiseCancellationModel | null;
  dtlnModelDir?: string;
  active: boolean;
}

export interface SerializedNoiseCancellation {
  placement: NoiseCancellationPlacement;
  engine: NoiseCancellationEngine | 'none';
  model: NoiseCancellationModel | null;
}
