import {
  NoiseCancellationEngine as Engine,
  NoiseCancellationModel as Model,
  NoiseCancellationPlacement as Placement,
  type ResolvedNoiseCancellation,
  type SerializedNoiseCancellation,
} from '@plumbus/voice/noise-cancellation';

/** Trust server-serialized NC from the token route — no @plumbus/core on the browser path. */
export function resolvedNoiseCancellationFromToken(
  serialized?: SerializedNoiseCancellation,
): ResolvedNoiseCancellation {
  if (!serialized || serialized.placement === Placement.Off || serialized.engine === 'none') {
    return {
      placement: Placement.Off,
      engine: 'none',
      model: null,
      active: false,
    };
  }
  return {
    placement: serialized.placement,
    engine: serialized.engine,
    model: serialized.model,
    active: true,
  };
}

export async function applyClientNoiseCancellation(args: {
  localAudioTrack: {
    setProcessor: (processor: unknown) => Promise<void>;
  };
  config: ResolvedNoiseCancellation;
}): Promise<boolean> {
  if (args.config.placement !== Placement.Client || !args.config.active) {
    return false;
  }

  if (args.config.engine === Engine.Krisp) {
    try {
      const krisp = await import('@livekit/krisp-noise-filter');
      const useBvc = args.config.model === Model.Bvc;
      const quality = args.config.model === Model.Lite ? ('low' as const) : ('medium' as const);
      await args.localAudioTrack.setProcessor(
        krisp.KrispNoiseFilter({
          useBVC: useBvc,
          quality,
        }),
      );
      return true;
    } catch (error) {
      console.warn('[voice-nc] client Krisp unavailable; continuing without NC', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  if (args.config.engine === Engine.Rnnoise) {
    console.warn('[voice-nc] client RNNoise is not yet available; continuing without NC');
    return false;
  }

  return false;
}

export function micConstraintsForNoiseCancellation(config: ResolvedNoiseCancellation): {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceIsolation: boolean;
} {
  return {
    echoCancellation: true,
    noiseSuppression: !config.active,
    autoGainControl: true,
    // livekit-client defaults voiceIsolation to true, silently stacking an
    // extra isolation stage in front of whatever NC (if any) is configured.
    // STT input should see at most one enhancement stage — never a hidden one.
    voiceIsolation: false,
  };
}
