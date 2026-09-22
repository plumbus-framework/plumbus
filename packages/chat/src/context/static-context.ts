import type { ExecutionContext } from '@plumbus/core';
import { stableHash } from '../internal/stable-hash.js';
import type { ContextItem, ContextSource, ResolvedContext } from '../types/context.js';
import type { TurnContext } from '../types/turn.js';

export function staticContext(opts: {
  id?: string;
  items: ContextItem[];
  sourceId?: string;
  includeIf?: (turnCtx: TurnContext) => boolean;
  format?: 'list' | 'table' | 'paragraphs';
}): ContextSource {
  const id = opts.id ?? `static:${stableHash(opts.items.map((i) => i.id))}`;

  return {
    kind: 'static',
    id,
    async resolve(_ctx: ExecutionContext, turnCtx: TurnContext): Promise<ResolvedContext> {
      if (opts.includeIf && !opts.includeIf(turnCtx)) {
        return { items: [], sources: [], estimatedTokens: 0 };
      }
      const estimatedTokens = Math.ceil(
        opts.items.reduce((s, it) => s + JSON.stringify(it.content).length, 0) / 4,
      );
      return {
        items: opts.items.map((it) => ({ ...it, sourceId: it.sourceId ?? opts.sourceId ?? id })),
        sources: [],
        estimatedTokens,
      };
    },
  };
}
