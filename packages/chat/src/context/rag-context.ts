/**
 * Direct RAG context: `ragContext({ corpus, query, filter })` references a corpus identifier
 * pre-registered in the consumer app's RAG configuration (`plumbus rag ingest`).
 * Uses `ctx.ai.retrieve({ corpus, query, filter })`.
 */
import type { ExecutionContext } from '@plumbus/core';
import { stableHash } from '../internal/stable-hash.js';
import type { ContextItem, ContextSource, ResolvedContext } from '../types/context.js';
import type { TurnContext } from '../types/turn.js';

const warnedAudienceFilter = new Set<string>();

export function ragContext(opts: {
  id?: string;
  corpus: string;
  query: string | ((turnCtx: TurnContext) => string);
  topK?: number;
  minScore?: number;
  filter?: (turnCtx: TurnContext) => Record<string, unknown>;
  sourceId?: string;
  /** When set and consumer omitted filter, default ({ audience }) => ({ audience }) */
  parentChatAudiencePolicy?: boolean;
}): ContextSource {
  const id = opts.id ?? `knowledge:${stableHash({ corpus: opts.corpus, sourceId: opts.sourceId })}`;

  return {
    kind: 'knowledge',
    id,
    async resolve(ctx: ExecutionContext, turnCtx: TurnContext): Promise<ResolvedContext> {
      const query = typeof opts.query === 'function' ? opts.query(turnCtx) : opts.query;
      let filter = opts.filter?.(turnCtx);
      if (opts.parentChatAudiencePolicy && !opts.filter) {
        if (!warnedAudienceFilter.has(id)) {
          warnedAudienceFilter.add(id);
          console.warn(
            `[@plumbus/chat] ragContext "${id}": applying default audience metadata filter`,
          );
        }
        filter = { audience: turnCtx.audience };
      }

      const docs = await ctx.ai.retrieve({
        corpus: opts.corpus,
        query,
        filter,
        limit: opts.topK ?? 5,
        minScore: opts.minScore ?? 0,
      });

      const items: ContextItem[] = docs.map((d, i) => ({
        id: `${id}:item:${i}`,
        kind: 'text' as const,
        content: d.content,
        sourceId: opts.sourceId ?? id,
        score: d.score,
      }));

      const estimatedTokens = Math.ceil(
        items.reduce((s, it) => s + String(it.content).length, 0) / 4,
      );

      return { items, sources: [], estimatedTokens };
    },
  };
}
