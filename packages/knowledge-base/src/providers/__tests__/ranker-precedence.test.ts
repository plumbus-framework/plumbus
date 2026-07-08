import { describe, expect, it, vi } from 'vitest';
import { staticBlocks } from '../static-blocks.js';
import type { ScoredBlock } from '../types/result.js';

describe('K13 ranker precedence', () => {
  it('source-level ranker applies when factory omits explicit ranker', async () => {
    const sourceRanker = vi.fn((blocks: ScoredBlock[]) => blocks.slice().reverse());
    const provider = staticBlocks({
      blocks: [{ text: 'a' }, { text: 'b' }],
    });

    const result = await provider.getBlock({} as never, {}, { ranker: sourceRanker });

    expect(sourceRanker).toHaveBeenCalledOnce();
    expect(result).toBe('b\n\na');
  });

  it('provider factory ranker wins over registry-passed source ranker', async () => {
    const factoryRanker = vi.fn((blocks: ScoredBlock[]) => blocks);
    const sourceRanker = vi.fn((blocks: ScoredBlock[]) => blocks.slice().reverse());

    const provider = staticBlocks({
      blocks: [{ text: 'a' }, { text: 'b' }],
      ranker: factoryRanker,
    });

    await provider.getBlock({} as never, {}, { ranker: sourceRanker });

    expect(factoryRanker).toHaveBeenCalledOnce();
    expect(sourceRanker).not.toHaveBeenCalled();
  });
});
