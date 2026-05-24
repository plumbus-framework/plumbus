import type { ResolvedContext } from '../types/context.js';

let tokenCounter: (text: string) => number = (text) => Math.ceil(text.length / 4);

export function setTokenCounter(fn: (text: string) => number): void {
  tokenCounter = fn;
}

export function trimContextToBudget(resolved: ResolvedContext, budget: number): ResolvedContext {
  const items = [...resolved.items];
  let total = tokenCounter(items.map((i) => JSON.stringify(i.content)).join('\n'));
  if (total <= budget) return resolved;

  const staticItems = items.filter((i) => i.sourceId?.startsWith('static') || !i.score);
  const knowledge = items.filter((i) => !staticItems.includes(i));
  knowledge.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  const kept = [...staticItems];
  for (const k of knowledge) {
    const trial = [...kept, k];
    const t = tokenCounter(trial.map((i) => JSON.stringify(i.content)).join('\n'));
    if (t <= budget) {
      kept.push(k);
      total = t;
    }
  }

  return {
    items: kept,
    sources: resolved.sources,
    estimatedTokens: total,
  };
}
