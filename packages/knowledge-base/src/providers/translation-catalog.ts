import type { ExecutionContext, TranslationDefinition } from '@plumbus/core';
import { createTranslationResolver } from '@plumbus/core';
import type { KnowledgeProvider } from '../types/provider.js';
import { KnowledgeError, KnowledgeErrorCode } from '../internal/knowledge-error.js';
import { packBlocks } from '../ranker/pack-blocks.js';
import type { ScoredBlock } from '../types/result.js';

export function translationCatalog(opts: {
  namespaces: string[];
  keyFilter?: (key: string) => boolean;
  /** Static definitions for namespace/key enumeration; values prefer live `ctx.translations` when locale matches. */
  definitions?: TranslationDefinition[];
  /**
   * Override catalog resolution. When omitted, defaults to reading from `ctx.translations`
   * (locale-bound `t(key)`) using `definitions` for key lists, or `keysByNamespace` when
   * definitions are not passed.
   */
  getCatalog?: (locale: string, ctx: ExecutionContext) => Record<string, Record<string, string>>;
  /** Explicit keys per namespace when `definitions` are not available (tests / custom catalogs). */
  keysByNamespace?: Record<string, string[]>;
}): KnowledgeProvider {
  const staticResolver = opts.definitions ? createTranslationResolver(opts.definitions) : null;

  const resolveCatalog =
    opts.getCatalog ??
    ((locale: string, ctx: ExecutionContext) =>
      defaultCatalogFromTranslations(ctx, locale, opts, staticResolver));

  return {
    async getBlock(ctx, scope, { maxTokens } = {}) {
      const locale = scope.locale ?? 'en';
      const catalog = resolveCatalog(locale, ctx);
      const lines: ScoredBlock[] = [];

      for (const ns of opts.namespaces) {
        const block = catalog[ns];
        if (!block) {
          throw new KnowledgeError(
            KnowledgeErrorCode.translationUnavailable,
            `namespace "${ns}" unavailable for locale "${locale}"`,
          );
        }
        for (const [key, value] of Object.entries(block)) {
          if (opts.keyFilter && !opts.keyFilter(key)) continue;
          lines.push({ text: `${key}: ${value}`, score: 1 });
        }
      }

      return packBlocks(lines, maxTokens);
    },
    async getTools() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 2 getTools');
    },
    async search() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 3 search');
    },
  };
}

function defaultCatalogFromTranslations(
  ctx: ExecutionContext,
  locale: string,
  opts: {
    namespaces: string[];
    definitions?: TranslationDefinition[];
    keysByNamespace?: Record<string, string[]>;
    keyFilter?: (key: string) => boolean;
  },
  staticResolver: ReturnType<typeof createTranslationResolver> | null,
): Record<string, Record<string, string>> {
  const catalog: Record<string, Record<string, string>> = {};

  for (const ns of opts.namespaces) {
    const keys = listNamespaceKeys(ns, opts);
    if (keys.length === 0) {
      throw new KnowledgeError(
        KnowledgeErrorCode.translationUnavailable,
        `no keys for namespace "${ns}" — pass definitions, keysByNamespace, or getCatalog`,
      );
    }

    catalog[ns] = {};
    for (const key of keys) {
      if (opts.keyFilter && !opts.keyFilter(key)) continue;
      const fullKey = `${ns}.${key}`;
      catalog[ns][key] = resolveTranslationValue(ctx, locale, fullKey, staticResolver);
    }
  }

  return catalog;
}

function listNamespaceKeys(
  namespace: string,
  opts: {
    definitions?: TranslationDefinition[];
    keysByNamespace?: Record<string, string[]>;
  },
): string[] {
  if (opts.keysByNamespace?.[namespace]) {
    return opts.keysByNamespace[namespace];
  }
  const def = opts.definitions?.find((d) => d.name === namespace);
  if (!def) return [];
  const locales = Object.keys(def.messages);
  const keys = new Set<string>();
  for (const loc of locales) {
    const messages = def.messages[loc];
    if (messages) {
      for (const key of Object.keys(messages)) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

function resolveTranslationValue(
  ctx: ExecutionContext,
  locale: string,
  fullKey: string,
  staticResolver: ReturnType<typeof createTranslationResolver> | null,
): string {
  if (ctx.translations.locale === locale) {
    return ctx.translations.t(fullKey);
  }
  if (staticResolver) {
    return staticResolver.t(locale, fullKey);
  }
  throw new KnowledgeError(
    KnowledgeErrorCode.translationUnavailable,
    `locale "${locale}" does not match ctx.translations.locale "${ctx.translations.locale}" and no definitions were provided for fallback`,
  );
}
