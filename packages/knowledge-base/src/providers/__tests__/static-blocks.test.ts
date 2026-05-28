import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { staticBlocks } from '../static-blocks.js';
import { KnowledgeError } from '../../internal/knowledge-error.js';

describe('staticBlocks', () => {
  const ctx = createTestContext();
  const provider = staticBlocks({
    blocks: [
      { text: 'user en', scope: { audience: 'user', locale: 'en' } },
      { text: 'admin he', scope: { audience: 'admin', locale: 'he' } },
      { text: 'global' },
    ],
  });

  it('filters by audience and locale', async () => {
    const block = await provider.getBlock(ctx, { audience: 'user', locale: 'en' });
    expect(block).toContain('user en');
    expect(block).not.toContain('admin he');
  });

  it('packs to maxTokens budget', async () => {
    const block = await provider.getBlock(ctx, {}, { maxTokens: 5 });
    expect(block.length).toBeGreaterThan(0);
  });

  it('ignores query', async () => {
    const a = await provider.getBlock(ctx, {}, { query: 'ignored' });
    const b = await provider.getBlock(ctx, {});
    expect(a).toBe(b);
  });

  it('throws tier_not_supported for getTools and search', async () => {
    await expect(provider.getTools?.(ctx, {})).rejects.toThrow(KnowledgeError);
    await expect(provider.search?.(ctx, 'q', {})).rejects.toThrow(/knowledge\.tier_not_supported/);
  });
});
