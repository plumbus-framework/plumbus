import type { ExecutionContext } from '@plumbus/core';
import type { ChatSourceRef, ContextSource, ResolvedContext } from '../types/context.js';
import type { TurnContext } from '../types/turn.js';

export async function resolveContextSources(
  ctx: ExecutionContext,
  sources: ContextSource[],
  turnCtx: TurnContext,
  opts: { perSourceTimeoutMs: number; onError: 'skip' | 'fail' },
): Promise<ResolvedContext & { sourceRefs: ChatSourceRef[] }> {
  const perSource = await Promise.all(
    sources.map(async (source, index) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.perSourceTimeoutMs);
      try {
        const resolved = await source.resolve(ctx, turnCtx);
        return { index, source, resolved };
      } catch (err) {
        if (opts.onError === 'fail') throw err;
        return { index, source, resolved: null };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const items = [];
  const sourceRefs: ChatSourceRef[] = [];
  let tokenSum = 0;

  for (const entry of perSource.sort((a, b) => a.index - b.index)) {
    if (!entry.resolved) continue;
    const handle = `src_${String.fromCharCode(97 + sourceRefs.length)}${sourceRefs.length > 25 ? sourceRefs.length : ''}`;
    const ref: ChatSourceRef = {
      id: handle,
      origin: entry.source.kind,
      label: entry.source.id,
      metadata: { sourceKey: entry.source.id },
    };
    sourceRefs.push(ref);
    for (const item of entry.resolved.items) {
      items.push({ ...item, sourceId: item.sourceId ?? handle });
    }
    tokenSum += entry.resolved.estimatedTokens;
  }

  return {
    items,
    sources: sourceRefs,
    estimatedTokens: tokenSum,
    sourceRefs,
  };
}
