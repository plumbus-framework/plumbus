import { describe, expect, it } from '@plumbus/core/testing';
import { stripInvalidFromAnswer, validateCitations } from '../../runtime/provenance.js';

describe('provenance', () => {
  it('splits valid and invalid citations', () => {
    const allowed = new Set(['src_a1']);
    const { valid, invalid } = validateCitations(['src_a1', 'src_fake'], allowed);
    expect(valid).toEqual(['src_a1']);
    expect(invalid).toEqual(['src_fake']);
  });

  it('strips invalid markers from answer', () => {
    const out = stripInvalidFromAnswer('See [src:fake_id] here', ['fake_id']);
    expect(out).not.toContain('[src:fake_id]');
  });
});
