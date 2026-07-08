import type { ExecutionContext } from '@plumbus/core';
import type { ChatSourceRef, ContextSource, ResolvedContext } from '../types/context.js';
import type { TurnContext } from '../types/turn.js';

function contextSourceTimeoutError(sourceId: string): Error {
  const err = new Error(`Context source "${sourceId}" timed out`);
  err.name = 'ContextSourceTimeoutError';
  return err;
}

async function resolveOneSource(
  ctx: ExecutionContext,
  source: ContextSource,
  turnCtx: TurnContext,
  perSourceTimeoutMs: number,
): Promise<ResolvedContext> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perSourceTimeoutMs);
  const signals: AbortSignal[] = [controller.signal, turnCtx.signal];
  const combined =
    typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : controller.signal;

  try {
    return await Promise.race([
      source.resolve(ctx, turnCtx),
      new Promise<ResolvedContext>((_resolve, reject) => {
        const onAbort = () => reject(contextSourceTimeoutError(source.id));
        combined.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveContextSources(
  ctx: ExecutionContext,
  sources: ContextSource[],
  turnCtx: TurnContext,
  opts: { perSourceTimeoutMs: number; onError: 'skip' | 'fail' },
): Promise<ResolvedContext & { sourceRefs: ChatSourceRef[] }> {
  const perSource = await Promise.all(
    sources.map(async (source, index) => {
      try {
        const resolved = await resolveOneSource(ctx, source, turnCtx, opts.perSourceTimeoutMs);
        return { index, source, resolved };
      } catch (err) {
        if (opts.onError === 'fail') throw err;
        if (err instanceof Error && err.name === 'ContextSourceTimeoutError') {
          ctx.logger.warn(
            `Context source "${source.id}" timed out after ${opts.perSourceTimeoutMs}ms — skipped`,
            { sourceId: source.id, perSourceTimeoutMs: opts.perSourceTimeoutMs },
          );
        }
        return { index, source, resolved: null };
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
