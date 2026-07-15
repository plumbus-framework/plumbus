// ── next-intl Re-export ──
// Prefer generated `i18n/useTranslations` (typed to the catalog). This subpath
// re-exports runtime APIs; `next-intl` is also a peer so AppConfig augmentation
// and this package resolve the same install.
// Usage: import { useFormatter, NextIntlClientProvider } from "@plumbus/ui/next-intl";

import type { IntlError } from 'next-intl';
import { useTranslations as useTranslationsBase } from 'next-intl';
import type { ReactNode } from 'react';

export type { ICUArgs, IntlError } from 'next-intl';
export {
  IntlErrorCode,
  NextIntlClientProvider,
  useFormatter,
  useTranslations,
} from 'next-intl';

export interface MessageFallbackArgs {
  namespace?: string;
  key: string;
  error: IntlError;
}

/**
 * Untyped translator surface used by generated `i18n/useTranslations`.
 * Values are `unknown` so the catalog wrapper can forward typed ICU args without casts.
 */
export type CatalogTranslator = {
  (key: string, ...args: unknown[]): string;
  rich(key: string, ...args: unknown[]): ReactNode;
  markup(key: string, ...args: unknown[]): string;
  raw(key: string): unknown;
  has(key: string): boolean;
};

/** Runtime bridge: next-intl hook with a string-key surface for generated wrappers. */
export function useCatalogTranslations(namespace: string): CatalogTranslator {
  const t = useTranslationsBase(namespace);

  function bridge(key: string, ...args: unknown[]): string {
    return t(key, args[0] as never);
  }

  bridge.rich = (key: string, ...args: unknown[]): ReactNode => t.rich(key, args[0] as never);

  bridge.markup = (key: string, ...args: unknown[]): string => t.markup(key, args[0] as never);

  bridge.raw = (key: string): unknown => t.raw(key);

  bridge.has = (key: string): boolean => t.has(key);

  return bridge;
}

/**
 * Visible sentinel for missing / failed messages.
 * Used by generated TranslationProvider and request config — no throw, no blank.
 */
export function getMissingMessageFallback({ namespace, key }: MessageFallbackArgs): string {
  const path = [namespace, key].filter((part) => part != null && part !== '').join('.');
  return `[missing: ${path}]`;
}

/** Log intl errors to the console; never crash the React tree. */
export function onTranslationError(error: IntlError): void {
  console.error(error);
}
