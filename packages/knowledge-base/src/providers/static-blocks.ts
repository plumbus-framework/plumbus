import type { KnowledgeProvider } from '../types/provider.js';
import type { ScoredBlock } from '../types/result.js';
import type { KnowledgeScope } from '../types/scope.js';
import { KnowledgeError, KnowledgeErrorCode } from '../internal/knowledge-error.js';
import { filterBlocksByScope, scopeSpecificityRanker } from '../ranker/scope-specificity.js';
import { packBlocks } from '../ranker/pack-blocks.js';

export function staticBlocks(opts: {
  blocks: Array<{ text: string; scope?: KnowledgeScope }>;
  ranker?: (blocks: ScoredBlock[], scope: KnowledgeScope) => ScoredBlock[];
}): KnowledgeProvider {
  const ranker = opts.ranker ?? scopeSpecificityRanker;
  const scored: ScoredBlock[] = opts.blocks.map((b, index) => ({
    text: b.text,
    score: opts.blocks.length - index,
    scope: b.scope,
  }));

  return {
    async getBlock(_ctx, scope, { maxTokens } = {}) {
      const filtered = filterBlocksByScope(scored, scope);
      const ranked = ranker(filtered, scope);
      return packBlocks(ranked, maxTokens);
    },
    async getTools() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 2 getTools');
    },
    async search() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 3 search');
    },
  };
}
