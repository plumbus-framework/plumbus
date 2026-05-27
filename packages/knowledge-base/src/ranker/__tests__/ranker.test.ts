import { describe, expect, it } from 'vitest';
import { scopeSpecificityRanker } from '../scope-specificity.js';
import { packBlocks } from '../pack-blocks.js';
import type { ScoredBlock } from '../../types/result.js';

describe('scopeSpecificityRanker', () => {
  it('ranks more specific scope higher', () => {
    const blocks: ScoredBlock[] = [
      { text: 'generic', score: 10 },
      { text: 'specific', score: 1, scope: { audience: 'user', locale: 'en' } },
    ];
    const ranked = scopeSpecificityRanker(blocks, { audience: 'user', locale: 'en' });
    expect(ranked[0]?.text).toBe('specific');
  });
});

describe('packBlocks', () => {
  it('respects token budget', () => {
    const packed = packBlocks(
      [
        { text: 'first block', score: 1 },
        { text: 'second block that should not fit', score: 1 },
      ],
      5,
    );
    expect(packed).toContain('first');
    expect(packed).not.toContain('second');
  });

  it('joins all when no maxTokens', () => {
    expect(
      packBlocks([
        { text: 'one', score: 1 },
        { text: 'two', score: 1 },
      ]),
    ).toBe('one\n\ntwo');
  });
});
