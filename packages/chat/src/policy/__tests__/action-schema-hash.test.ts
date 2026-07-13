import { describe, expect, it } from 'vitest';
import { capabilityActionHashV2 } from '../action-schema-hash.js';

describe('action schema hash', () => {
  it('v2 hash changes when proposed payload changes', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } } };
    const a = capabilityActionHashV2(schema, { id: '1' });
    const b = capabilityActionHashV2(schema, { id: '2' });
    expect(a).not.toBe(b);
    expect(a.startsWith('v2:')).toBe(true);
  });
});
