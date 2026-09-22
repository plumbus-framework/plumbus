import { describe, expect, it } from 'vitest';
import { PlumbusError } from '@plumbus/core';
import { createSTTProvider } from '../../providers/factory.js';
import { createProviderRegistry } from '../../providers/registry.js';

describe('voice runtime structured errors', () => {
  it('createSTTProvider throws PlumbusError for unregistered provider ids', () => {
    const registry = createProviderRegistry();
    expect(() =>
      createSTTProvider({
        registry,
        providers: { providers: { soniox: { apiKey: 'k' } } },
        voiceSlice: { provider: 'soniox' },
      }),
    ).toThrow(PlumbusError);

    try {
      createSTTProvider({
        registry,
        providers: { providers: { soniox: { apiKey: 'k' } } },
        voiceSlice: { provider: 'soniox' },
      });
      expect.fail('expected createSTTProvider to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PlumbusError);
      expect((error as PlumbusError).message).toContain('not registered');
      expect((error as PlumbusError).metadata?.installPackage).toBeUndefined();
    }
  });
});
