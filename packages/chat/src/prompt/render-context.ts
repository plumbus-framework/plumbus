import type { ResolvedContext } from '../types/context.js';

export function renderContext(resolved: ResolvedContext): string {
  const blocks: string[] = [];
  for (const item of resolved.items) {
    const handle = item.sourceId ? `[src:${item.sourceId}]` : '';
    const body =
      item.kind === 'json' ? JSON.stringify(item.content, null, 2) : String(item.content);
    blocks.push(`${handle}\n${body}`);
  }
  return blocks.join('\n\n');
}
