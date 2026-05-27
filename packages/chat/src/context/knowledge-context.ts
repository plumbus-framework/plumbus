import type { ExecutionContext } from '@plumbus/core';
import type { KnowledgeRegistry, KnowledgeScope } from '@plumbus/knowledge-base';
import { stableHash } from '../internal/stable-hash.js';
import type { ContextItem, ContextSource, ResolvedContext } from '../types/context.js';
import type { TurnContext } from '../types/turn.js';

const CHAT_TIER_TOOLS_ERROR_PREFIX = 'knowledge.chat_tier_not_supported';

export function knowledgeContext(opts: {
  registry: KnowledgeRegistry;
  source: string;
  tier?: 'block' | 'tools';
  scopeFromTurn?: (turnCtx: TurnContext) => KnowledgeScope;
  queryFromTurn?: (turnCtx: TurnContext) => string;
  id?: string;
  sourceId?: string;
}): ContextSource {
  if (opts.tier === 'tools') {
    throw new Error(
      `${CHAT_TIER_TOOLS_ERROR_PREFIX}: tier 'tools' is interface-only in @plumbus/knowledge-base v1 and is not executed by @plumbus/chat@0.1.4. Use tier: 'block'.`,
    );
  }

  const id =
    opts.id ??
    `kb:${stableHash({ source: opts.source, registry: opts.registry.list().map((s) => s.name) })}`;

  const defaultScopeFromTurn = (turnCtx: TurnContext): KnowledgeScope => ({
    audience: turnCtx.audience,
    locale: turnCtx.locale,
    tenantId: turnCtx.tenantId,
  });

  return {
    kind: 'knowledge',
    id,
    async resolve(ctx: ExecutionContext, turnCtx: TurnContext): Promise<ResolvedContext> {
      const scope = (opts.scopeFromTurn ?? defaultScopeFromTurn)(turnCtx);
      const query = opts.queryFromTurn?.(turnCtx);
      const block = await opts.registry.get(opts.source).getBlock(ctx, scope, {
        maxTokens: turnCtx.contextTokenBudget,
        query,
      });

      const items: ContextItem[] = [
        {
          id: `${id}:block`,
          kind: 'text',
          content: block,
          sourceId: opts.sourceId ?? opts.source,
        },
      ];

      const estimatedTokens = Math.ceil(block.length / 4);
      return { items, sources: [], estimatedTokens };
    },
  };
}

export { CHAT_TIER_TOOLS_ERROR_PREFIX };
