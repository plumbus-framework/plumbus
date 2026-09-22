// ── Translations Module ──
// Server-side translation registry and resolver.
// Provides ICU MessageFormat interpolation for backend use
// (capability error messages, flow status, etc.)
//
// Key exports: TranslationRegistry, createTranslationResolver, computeStatus

import type { TranslationDefinition, TranslationService } from '../types/translation.js';

export type { LocaleStatus, NamespaceStatus, TranslationStatus } from './status.js';
export { computeStatus, formatTranslationStatus } from './status.js';

/**
 * Lightweight ICU MessageFormat interpolation.
 * Handles:
 * - Simple placeholders: {name} → value
 * - Plural rules: {count, plural, one {# item} other {# items}}
 * - Select: {gender, select, male {He} female {She} other {They}}
 *
 * The `#` symbol inside plural branches is replaced with the numeric value.
 */
function interpolateICU(template: string, params: Record<string, string | number>): string {
  // Handle plural / select blocks first
  let result = template.replace(
    /\{(\w+),\s*(plural|select),\s*((?:[^{}]|\{[^{}]*\})*)\}/g,
    (_match, paramName: string, type: string, branches: string) => {
      const value = params[paramName];
      if (value === undefined) return _match;

      // Parse branches: "one {# item} other {# items}" → { one: "# item", other: "# items" }
      const branchMap: Record<string, string> = {};
      const branchRegex = /(\w+)\s*\{([^}]*)\}/g;
      for (const branchMatch of branches.matchAll(branchRegex)) {
        const branchKey = branchMatch[1];
        const branchValue = branchMatch[2];
        if (branchKey && branchValue !== undefined) {
          branchMap[branchKey] = branchValue;
        }
      }

      if (type === 'plural') {
        const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
        // Determine plural category (simplified — covers English / Hebrew basics)
        let category: string;
        if (num === 0) category = 'zero';
        else if (num === 1) category = 'one';
        else if (num === 2) category = 'two';
        else category = 'other';

        const branch =
          branchMap[`=${num}`] ?? branchMap[category] ?? branchMap.other ?? String(num);
        return branch.replace(/#/g, String(num));
      }

      // select
      const branch = branchMap[String(value)] ?? branchMap.other ?? String(value);
      return branch;
    },
  );

  // Handle simple {param} placeholders
  result = result.replace(/\{(\w+)\}/g, (_match, paramName: string) => {
    const value = params[paramName];
    return value !== undefined ? String(value) : _match;
  });

  return result;
}

/**
 * Registry that holds multiple translation definitions (namespaces)
 * and resolves keys at runtime.
 */
export class TranslationRegistry {
  private readonly namespaces = new Map<string, TranslationDefinition>();

  /** Register a translation definition (namespace) */
  register(definition: TranslationDefinition): void {
    this.namespaces.set(definition.name, definition);
  }

  /** Register multiple definitions at once */
  registerAll(definitions: TranslationDefinition[]): void {
    for (const def of definitions) {
      this.register(def);
    }
  }

  /**
   * Resolve a translated string.
   *
   * @param locale - Target locale (e.g. "he")
   * @param key - Dot-namespaced key: "namespace.messageKey" (e.g. "errors.projectNotFound")
   *              or plain key if namespace is provided separately
   * @param params - ICU interpolation params
   */
  t(locale: string, key: string, params?: Record<string, string | number>): string {
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) {
      return key; // No namespace — return key as-is
    }

    const namespace = key.substring(0, dotIndex);
    const messageKey = key.substring(dotIndex + 1);
    const definition = this.namespaces.get(namespace);

    if (!definition) {
      return key; // Unknown namespace — return key as-is
    }

    // Try requested locale, fall back to default locale
    const messages = definition.messages[locale] ?? definition.messages[definition.defaultLocale];
    if (!messages) {
      return key;
    }

    const template = messages[messageKey];
    if (template === undefined) {
      // Try default locale as fallback
      const fallback = definition.messages[definition.defaultLocale];
      const fallbackTemplate = fallback?.[messageKey];
      if (fallbackTemplate === undefined) {
        return key; // Key not found anywhere — return key
      }
      return params ? interpolateICU(fallbackTemplate, params) : fallbackTemplate;
    }

    return params ? interpolateICU(template, params) : template;
  }

  /** Get all registered namespace names */
  getNamespaces(): string[] {
    return Array.from(this.namespaces.keys());
  }

  /** Get a specific definition by name */
  getDefinition(name: string): TranslationDefinition | undefined {
    return this.namespaces.get(name);
  }

  /** Get all registered definitions */
  getAllDefinitions(): TranslationDefinition[] {
    return Array.from(this.namespaces.values());
  }

  /** Union of all locale codes declared on registered translation definitions. */
  getSupportedLocales(): string[] {
    const locales = new Set<string>();
    for (const def of this.namespaces.values()) {
      for (const locale of def.locales) {
        locales.add(locale);
      }
    }
    return Array.from(locales);
  }
}

/**
 * Create a translation resolver from a set of translation definitions.
 * Returns an object with a `t(locale, key, params?)` method.
 */
export function createTranslationResolver(definitions: TranslationDefinition[]): {
  t(locale: string, key: string, params?: Record<string, string | number>): string;
} {
  const registry = new TranslationRegistry();
  registry.registerAll(definitions);
  return {
    t: (locale, key, params) => registry.t(locale, key, params),
  };
}

/**
 * Create a locale-bound TranslationService from a registry.
 * Used to inject into ExecutionContext — the locale is resolved once per request.
 */
export function createTranslationService(
  registry: TranslationRegistry,
  locale: string,
): TranslationService {
  return {
    locale,
    t: (key, params) => registry.t(locale, key, params),
  };
}
