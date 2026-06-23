import { PlumbusError, ErrorCode } from '@plumbus/core';
import type {
  NoiseCancellationEngine,
  NoiseCancellationModel,
  NoiseCancellationPlacement,
  ResolvedNoiseCancellation,
  SerializedNoiseCancellation,
  VoiceNoiseCancellationConfig,
} from '../../types/noise-cancellation.js';
import {
  NoiseCancellationEngine as Engine,
  NoiseCancellationModel as Model,
  NoiseCancellationPlacement as Placement,
} from '../../types/noise-cancellation.js';

const PLACEMENTS = new Set<string>(Object.values(Placement));
const ENGINES = new Set<string>(Object.values(Engine));
const MODELS = new Set<string>(Object.values(Model));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlacement(value: unknown): NoiseCancellationPlacement {
  if (typeof value !== 'string' || !PLACEMENTS.has(value)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `noiseCancellation.placement must be one of: ${[...PLACEMENTS].join(', ')}`,
    );
  }
  return value as NoiseCancellationPlacement;
}

function parseEngine(value: unknown): NoiseCancellationEngine | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ENGINES.has(value)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `noiseCancellation.engine must be one of: ${[...ENGINES].join(', ')}`,
    );
  }
  return value as NoiseCancellationEngine;
}

function parseModel(value: unknown): NoiseCancellationModel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MODELS.has(value)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `noiseCancellation.model must be one of: ${[...MODELS].join(', ')}`,
    );
  }
  return value as NoiseCancellationModel;
}

function defaultEngine(placement: NoiseCancellationPlacement): NoiseCancellationEngine | 'none' {
  if (placement === Placement.Off) return 'none';
  return Engine.Krisp;
}

function defaultModel(engine: NoiseCancellationEngine | 'none'): NoiseCancellationModel | null {
  if (engine === 'none') return null;
  if (engine === Engine.Krisp) return Model.Bvc;
  return Model.Standard;
}

function validateEnginePlacement(
  placement: NoiseCancellationPlacement,
  engine: NoiseCancellationEngine | 'none',
  model: NoiseCancellationModel | null,
): void {
  if (placement === Placement.Off || engine === 'none') return;

  if (engine === Engine.Dtln && placement === Placement.Client) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'noiseCancellation.engine "dtln" is only supported with placement "agent"',
    );
  }

  if (engine === Engine.Krisp && model === Model.Lite) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'noiseCancellation.model "lite" is not valid for engine "krisp"',
    );
  }

  if (engine === Engine.Dtln && model !== null && model !== Model.Standard) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'noiseCancellation.engine "dtln" only supports model "standard"',
    );
  }
}

export function parseNoiseCancellation(raw: unknown): ResolvedNoiseCancellation {
  if (raw === undefined || raw === null) {
    return {
      placement: Placement.Off,
      engine: 'none',
      model: null,
      active: false,
    };
  }

  if (!isRecord(raw)) {
    throw new PlumbusError(ErrorCode.Validation, 'noiseCancellation must be an object');
  }

  const placement = parsePlacement(raw.placement);
  if (placement === Placement.Off) {
    return {
      placement: Placement.Off,
      engine: 'none',
      model: null,
      dtlnModelDir: undefined,
      active: false,
    };
  }

  const engine = parseEngine(raw.engine) ?? defaultEngine(placement);
  const model = parseModel(raw.model) ?? defaultModel(engine);

  validateEnginePlacement(placement, engine, model);

  const dtlnModelDir =
    typeof raw.dtlnModelDir === 'string' && raw.dtlnModelDir.length > 0
      ? raw.dtlnModelDir
      : undefined;

  return {
    placement,
    engine,
    model,
    dtlnModelDir,
    active: engine !== 'none',
  };
}

export function readNoiseCancellationFromTransportOptions(
  options?: Record<string, unknown>,
): ResolvedNoiseCancellation {
  if (!options) {
    return parseNoiseCancellation(undefined);
  }
  return parseNoiseCancellation(options.noiseCancellation);
}

export function serializeNoiseCancellation(
  resolved: ResolvedNoiseCancellation,
): SerializedNoiseCancellation {
  return {
    placement: resolved.placement,
    engine: resolved.engine,
    model: resolved.model,
  };
}

export function assertExclusiveNoiseCancellation(
  transportResolved: ResolvedNoiseCancellation,
  sessionOverride?: ResolvedNoiseCancellation,
): void {
  if (
    transportResolved.active &&
    sessionOverride?.active &&
    transportResolved.placement !== sessionOverride.placement
  ) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'noiseCancellation client and agent placements cannot both be active for one voice session',
    );
  }
  if (sessionOverride?.placement === Placement.Client && sessionOverride.engine === Engine.Dtln) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'noiseCancellation client placement does not support engine "dtln"',
    );
  }
}

export function toVoiceNoiseCancellationConfig(
  resolved: ResolvedNoiseCancellation,
): VoiceNoiseCancellationConfig | undefined {
  if (!resolved.active) return undefined;
  return {
    placement: resolved.placement,
    engine: resolved.engine === 'none' ? undefined : resolved.engine,
    model: resolved.model ?? undefined,
    dtlnModelDir: resolved.dtlnModelDir,
  };
}
