import { createRequire } from 'node:module';
import type { AudioFrame, FrameProcessor, NoiseCancellationOptions } from '@livekit/rtc-node';
import type { ResolvedNoiseCancellation } from '../../types/noise-cancellation.js';
import {
  NoiseCancellationEngine as Engine,
  NoiseCancellationModel as Model,
  NoiseCancellationPlacement as Placement,
} from '../../types/noise-cancellation.js';
import { createDtlnFrameProcessor } from './oss/dtln-frame-processor.js';
import { createRnnoiseFrameProcessor } from './oss/rnnoise-frame-processor.js';

const require = createRequire(import.meta.url);

export type AgentNoiseCancellationOption = NoiseCancellationOptions | FrameProcessor<AudioFrame>;

let warnedKrispAgentFallback = false;

function warnKrispAgentFallback(reason: string): void {
  if (warnedKrispAgentFallback) return;
  warnedKrispAgentFallback = true;
  console.warn('[voice-nc] agent Krisp unavailable; ingesting raw audio', { reason });
}

export function resolveAgentNoiseCancellationOption(
  config: ResolvedNoiseCancellation,
): AgentNoiseCancellationOption | undefined {
  if (config.placement !== Placement.Agent || !config.active) {
    return undefined;
  }

  if (config.engine === Engine.Krisp) {
    try {
      const livekitNc =
        require('@livekit/noise-cancellation-node') as typeof import('@livekit/noise-cancellation-node');
      if (config.model === Model.Bvc) {
        return livekitNc.BackgroundVoiceCancellation();
      }
      return livekitNc.NoiseCancellation();
    } catch (error) {
      warnKrispAgentFallback(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  if (config.engine === Engine.Rnnoise) {
    return createRnnoiseFrameProcessor({ lite: config.model === Model.Lite });
  }

  if (config.engine === Engine.Dtln) {
    return createDtlnFrameProcessor({ modelDir: config.dtlnModelDir });
  }

  return undefined;
}
