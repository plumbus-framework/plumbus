import { describe, expect, it } from 'vitest';
import { mockKnowledgeSource } from '../index.js';

describe('K14 mockKnowledgeSource scope', () => {
  it('stores optional scope on the source definition', () => {
    const source = mockKnowledgeSource('grounding', {
      name: 'scoped-kb',
      scope: { audience: 'partner' },
    });
    expect(source.definition.scope).toEqual({ audience: 'partner' });
  });
});
