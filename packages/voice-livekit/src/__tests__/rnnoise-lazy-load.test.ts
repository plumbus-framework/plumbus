import { describe, expect, it, vi } from 'vitest';
import { parseNoiseCancellation } from '@plumbus/voice/provider-kit';
import { resolveAgentNoiseCancellationOption } from '../noise-cancellation/resolve-noise-cancellation.js';

const wasm = vi.hoisted(() => ({ imported: vi.fn(), load: vi.fn(async () => null) }));
vi.mock('@shiguredo/rnnoise-wasm', () => {
  wasm.imported();
  return { Rnnoise: { load: wasm.load } };
});

describe('RNNoise deferred dependency', () => {
  it('loads the WASM package only when agent RNNoise is selected', async () => {
    expect(wasm.imported).not.toHaveBeenCalled();
    expect(resolveAgentNoiseCancellationOption(parseNoiseCancellation(undefined))).toBeUndefined();
    expect(
      resolveAgentNoiseCancellationOption(
        parseNoiseCancellation({ placement: 'client', engine: 'rnnoise' }),
      ),
    ).toBeUndefined();
    expect(wasm.imported).not.toHaveBeenCalled();
    const processor = resolveAgentNoiseCancellationOption(
      parseNoiseCancellation({ placement: 'agent', engine: 'rnnoise' }),
    );
    expect(processor).toBeDefined();
    await vi.waitFor(() => expect(wasm.load).toHaveBeenCalledOnce());
    // Failed initialization retains the established raw-audio fallback.
    const frame = { data: new Int16Array([10]), channels: 1, sampleRate: 48000 };
    expect((processor as any).process(frame)).toBe(frame);
    (processor as any).close();
  });
});
