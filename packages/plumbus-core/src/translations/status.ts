// ── Translation Status ──
// Coverage reporting: filled (non-empty) values vs default-locale key totals.

import type { TranslationDefinition } from '../types/translation.js';

export interface LocaleStatus {
  total: number;
  filled: number;
  percentage: number;
}

export interface NamespaceStatus {
  name: string;
  locales: Record<string, LocaleStatus>;
}

export interface TranslationStatus {
  namespaces: NamespaceStatus[];
  incomplete: number;
}

/**
 * Compute per-namespace / per-locale translation coverage.
 *
 * For each namespace, the default locale's key count is the `total`. A locale is
 * incomplete when fewer than `total` message values are non-empty strings.
 */
export function computeStatus(definitions: TranslationDefinition[]): TranslationStatus {
  let incomplete = 0;
  const namespaces: NamespaceStatus[] = definitions.map((def) => {
    const locales: Record<string, LocaleStatus> = {};
    const totalKeys = Object.keys(def.messages[def.defaultLocale] ?? {}).length;

    for (const locale of def.locales) {
      const messages = def.messages[locale] ?? {};
      const filled = Object.values(messages).filter((v) => v.length > 0).length;
      const percentage = totalKeys > 0 ? Math.round((filled / totalKeys) * 100) : 100;
      locales[locale] = { total: totalKeys, filled, percentage };
      if (filled < totalKeys) incomplete++;
    }

    return { name: def.name, locales };
  });

  return { namespaces, incomplete };
}

/** Format a human-readable coverage summary (same lines as `plumbus translation status`). */
export function formatTranslationStatus(status: TranslationStatus): string[] {
  return status.namespaces.map((ns) => {
    const parts = Object.entries(ns.locales)
      .map(([locale, s]) => `${locale} ${s.filled}/${s.total} (${s.percentage}%)`)
      .join(' | ');
    return `  ${ns.name}: ${parts}`;
  });
}
