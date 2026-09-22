import type { ExecutionContext } from '@plumbus/core';
import type { ContextItem } from '../types/context.js';
import { staticContext } from './static-context.js';

/**
 * @deprecated Use `createKnowledgeRegistry` with `translationCatalog` and `knowledgeContext({ registry, source })`.
 * Removal target: `@plumbus/chat` v0.2.
 */
export function staticContextFromTranslations(opts: {
  id?: string;
  namespaces: string[];
  keyFilter?: (key: string) => boolean;
  sourceId?: string;
  /** Optional catalog provider for tests / apps without enumerable translation registry */
  getCatalog?: (locale: string) => Record<string, Record<string, string>>;
}): import('../types/context.js').ContextSource {
  return {
    kind: 'static',
    id: opts.id ?? `translations:${opts.namespaces.join(',')}`,
    async resolve(ctx: ExecutionContext, turnCtx) {
      const catalog = opts.getCatalog?.(turnCtx.locale) ?? {};
      const items: ContextItem[] = [];
      for (const ns of opts.namespaces) {
        const block = catalog[ns];
        if (!block) continue;
        for (const [key, value] of Object.entries(block)) {
          if (opts.keyFilter && !opts.keyFilter(key)) continue;
          items.push({
            id: `${ns}.${key}`,
            kind: 'text',
            content: { key: `${ns}.${key}`, value },
          });
        }
      }
      return staticContext({ id: opts.id, items, sourceId: opts.sourceId }).resolve(ctx, turnCtx);
    },
  };
}
