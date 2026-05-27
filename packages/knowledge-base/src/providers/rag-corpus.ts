import { z } from '@plumbus/core/zod';
import type { ExecutionContext } from '@plumbus/core';
import type { KnowledgeProvider } from '../types/provider.js';
import type { SearchResult } from '../types/result.js';
import type { KnowledgeScope } from '../types/scope.js';
import type { ToolDefinition } from '../types/tool.js';
import { KnowledgeError, KnowledgeErrorCode } from '../internal/knowledge-error.js';
import { packBlocks } from '../ranker/pack-blocks.js';
import { scopeToRetrieveFilter } from '../scope/to-retrieve-filter.js';

export function ragCorpus(opts: {
  corpus: string;
  mapScope?: (scope: KnowledgeScope) => Record<string, unknown>;
  queryStrategy?: 'fromOpts' | 'scopeAsQuery' | ((scope: KnowledgeScope) => string);
  topK?: number;
  minScore?: number;
}): KnowledgeProvider {
  const filterOf = opts.mapScope ?? scopeToRetrieveFilter;
  const topK = opts.topK ?? 5;

  const searchFn = async (
    ctx: ExecutionContext,
    query: string,
    scope: KnowledgeScope,
    searchOpts?: { topK?: number },
  ): Promise<SearchResult[]> => {
    try {
      const docs = await ctx.ai.retrieve({
        corpus: opts.corpus,
        query,
        filter: filterOf(scope),
        limit: searchOpts?.topK ?? topK,
        minScore: opts.minScore,
      });
      return docs.map((d) => ({
        content: d.content,
        score: d.score,
        metadata: d.metadata,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KnowledgeError(
        KnowledgeErrorCode.ragRetrieveFailed,
        `retrieve failed for corpus "${opts.corpus}": ${message}`,
      );
    }
  };

  return {
    async getBlock(ctx, scope, { maxTokens, query } = {}) {
      const q = resolveQuery(opts.queryStrategy ?? 'fromOpts', scope, query);
      if (!q) return '';
      const results = await searchFn(ctx, q, scope);
      return packBlocks(
        results.map((r) => ({ text: r.content, score: r.score, scope })),
        maxTokens,
      );
    },
    search: searchFn,
    async getTools(ctx, scope): Promise<ToolDefinition[]> {
      return [
        {
          name: `searchCorpus_${opts.corpus}`,
          description: `Search the ${opts.corpus} knowledge corpus.`,
          inputSchema: z.object({ query: z.string() }),
          handler: async (args: unknown) => {
            const parsed = z.object({ query: z.string() }).parse(args);
            return searchFn(ctx, parsed.query, scope);
          },
        },
      ];
    },
  };
}

function resolveQuery(
  strategy: 'fromOpts' | 'scopeAsQuery' | ((scope: KnowledgeScope) => string),
  scope: KnowledgeScope,
  query?: string,
): string | undefined {
  if (typeof strategy === 'function') {
    return strategy(scope);
  }
  if (strategy === 'scopeAsQuery') {
    const parts = [
      scope.audience,
      scope.locale,
      scope.tenantId,
      ...(scope.custom ? Object.values(scope.custom) : []),
    ].filter(Boolean);
    return parts.join(' ').trim() || undefined;
  }
  return query?.trim() || undefined;
}
