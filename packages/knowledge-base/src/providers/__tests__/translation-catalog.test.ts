import { describe, expect, it } from 'vitest';
import type { TranslationDefinition } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import { createTestAuth, createTestContext, createTestData } from '@plumbus/core/testing';
import { translationCatalog } from '../translation-catalog.js';

const helpTranslations: TranslationDefinition = {
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: { greeting: 'Hello', farewell: 'Bye' },
    he: { greeting: 'שלום', farewell: 'להתראות' },
  },
};

describe('translationCatalog', () => {
  it('returns Hebrew strings for he locale via getCatalog override', async () => {
    const ctx = createTestContext();
    const provider = translationCatalog({
      namespaces: ['common'],
      getCatalog: (locale) =>
        locale === 'he' ? { common: { greeting: 'שלום' } } : { common: { greeting: 'Hello' } },
    });
    const block = await provider.getBlock(ctx, { locale: 'he' });
    expect(block).toContain('שלום');
  });

  it('reads live values from ctx.translations when locale matches', async () => {
    const ctx = createExecutionContext({
      auth: createTestAuth(),
      data: createTestData(),
      translations: {
        locale: 'en',
        t: (key) => (key === 'common.greeting' ? 'Live Hello' : key),
      },
    });
    const provider = translationCatalog({
      namespaces: ['common'],
      definitions: [helpTranslations],
    });
    const block = await provider.getBlock(ctx, { locale: 'en' });
    expect(block).toContain('Live Hello');
    expect(block).not.toContain('greeting: Hello');
  });

  it('falls back to definitions resolver when locale differs from ctx', async () => {
    const ctx = createExecutionContext({
      auth: createTestAuth(),
      data: createTestData(),
      translations: { locale: 'en', t: (key) => key },
    });
    const provider = translationCatalog({
      namespaces: ['common'],
      definitions: [helpTranslations],
    });
    const block = await provider.getBlock(ctx, { locale: 'he' });
    expect(block).toContain('שלום');
  });

  it('applies keyFilter', async () => {
    const ctx = createTestContext();
    const provider = translationCatalog({
      namespaces: ['common'],
      getCatalog: () => ({ common: { keep: 'yes', drop: 'no' } }),
      keyFilter: (key) => key === 'keep',
    });
    const block = await provider.getBlock(ctx, { locale: 'en' });
    expect(block).toContain('keep');
    expect(block).not.toContain('drop');
  });
});
