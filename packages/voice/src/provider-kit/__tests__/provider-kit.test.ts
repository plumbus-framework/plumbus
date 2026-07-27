import { describe, expect, it } from 'vitest';
import * as kit from '../index.js';

const EXPECTED_RUNTIME_EXPORTS = [
  'Deferred',
  'NoiseCancellationEngine',
  'NoiseCancellationModel',
  'NoiseCancellationPlacement',
  'assertExclusiveNoiseCancellation',
  'assertOkResponse',
  'concatAudioChunks',
  'createVoiceSessionBudget',
  'decodeBase64Audio',
  'decodeHexAudio',
  'estimateAudioSeconds',
  'fetchCatalogJson',
  'fileExtensionForContentType',
  'getVoiceModelOption',
  'httpToWebSocketUrl',
  'joinUrl',
  'normalizeVoiceList',
  'parseAudioFormat',
  'parseNoiseCancellation',
  'readNoiseCancellationFromTransportOptions',
  'readOption',
  'readResponseChunks',
  'readResponseError',
  'resolveHttpBaseUrl',
  'resolveRuntimeFetch',
  'resolveRuntimeWebSocketFactory',
  'resolveTtsFetch',
  'resolveTtsWebSocketFactory',
  'resolveWebSocketUrl',
  'roundMetric',
  'serializeNoiseCancellation',
  'socketMessageToString',
  'toBase64',
  'toBlob',
  'toBlobPart',
  'toVendorAudioFormat',
  'wrapPcm16AsWav',
] as const;

describe('provider-kit barrel', () => {
  it('exposes the expected runtime symbols without vendor descriptors', () => {
    expect(Object.keys(kit).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS]);
  });

  it('has no undefined runtime exports', () => {
    const values = Object.values(kit);
    expect(values.length).toBe(EXPECTED_RUNTIME_EXPORTS.length);
    for (const value of values) {
      expect(value).not.toBeUndefined();
    }
  });
});
