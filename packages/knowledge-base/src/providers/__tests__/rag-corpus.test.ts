import { describe, expect, it, vi } from 'vitest';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { ragCorpus } from '../rag-corpus.js';
import { scopeToRetrieveFilter } from '../../scope/to-retrieve-filter.js';

describe('ragCorpus', () => {
  it('calls retrieve with default filter', async () => {
    const retrieve = vi.fn(async () => [{ content: 'doc', score: 0.9, source: 's1' }]);
    const ctx = createTestContext({ ai: { ...mockAI(), retrieve } });
    const provider = ragCorpus({ corpus: 'help' });
    const scope = { audience: 'user', locale: 'en' };
    await provider.getBlock(ctx, scope, { query: 'how to interview' });
    expect(ctx.ai.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        corpus: 'help',
        query: 'how to interview',
        filter: scopeToRetrieveFilter(scope),
      }),
    );
  });

  it('returns empty without query when fromOpts', async () => {
    const ctx = createTestContext();
    const provider = ragCorpus({ corpus: 'help' });
    expect(await provider.getBlock(ctx, {}, {})).toBe('');
  });

  it('uses scopeAsQuery strategy', async () => {
    const retrieve = vi.fn(async () => [{ content: 'x', score: 1, source: 's' }]);
    const ctx = createTestContext({ ai: { ...mockAI(), retrieve } });
    const provider = ragCorpus({ corpus: 'help', queryStrategy: 'scopeAsQuery' });
    await provider.getBlock(ctx, { audience: 'user', locale: 'en' });
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ query: 'user en' }));
  });

  it('honors mapScope override', async () => {
    const retrieve = vi.fn(async () => [{ content: 'x', score: 1, source: 's' }]);
    const ctx = createTestContext({ ai: { ...mockAI(), retrieve } });
    const provider = ragCorpus({
      corpus: 'help',
      mapScope: () => ({ customKey: 'v' }),
      queryStrategy: 'scopeAsQuery',
    });
    await provider.getBlock(ctx, { audience: 'user' });
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ filter: { customKey: 'v' } }));
  });

  it('wraps retrieve failures', async () => {
    const retrieve = vi.fn(async () => {
      throw new Error('boom');
    });
    const ctx = createTestContext({ ai: { ...mockAI(), retrieve } });
    const provider = ragCorpus({ corpus: 'help', queryStrategy: 'scopeAsQuery' });
    await expect(provider.getBlock(ctx, { audience: 'user' })).rejects.toThrow(
      /knowledge\.rag_retrieve_failed/,
    );
  });
});
