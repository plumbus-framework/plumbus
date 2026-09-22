import { describe, expect, it } from 'vitest';
import type { TranslationDefinition } from '../../types/translation.js';
import { computeStatus, formatTranslationStatus } from '../status.js';

const complete: TranslationDefinition = {
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: { 'nav.home': 'Home', save: 'Save' },
    he: { 'nav.home': 'בית', save: 'שמור' },
  },
};

const incomplete: TranslationDefinition = {
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: { 'nav.home': 'Home', save: 'Save' },
    he: { 'nav.home': 'בית', save: '' },
  },
};

describe('computeStatus', () => {
  it('reports complete coverage when all values are non-empty', () => {
    const status = computeStatus([complete]);
    expect(status.incomplete).toBe(0);
    expect(status.namespaces[0]?.locales.en).toEqual({
      total: 2,
      filled: 2,
      percentage: 100,
    });
    expect(status.namespaces[0]?.locales.he).toEqual({
      total: 2,
      filled: 2,
      percentage: 100,
    });
  });

  it('counts empty strings as unfilled', () => {
    const status = computeStatus([incomplete]);
    expect(status.incomplete).toBe(1);
    expect(status.namespaces[0]?.locales.he).toEqual({
      total: 2,
      filled: 1,
      percentage: 50,
    });
  });

  it('returns empty status for no definitions', () => {
    expect(computeStatus([])).toEqual({ namespaces: [], incomplete: 0 });
  });
});

describe('formatTranslationStatus', () => {
  it('formats coverage lines per namespace', () => {
    const lines = formatTranslationStatus(computeStatus([complete]));
    expect(lines).toEqual(['  common: en 2/2 (100%) | he 2/2 (100%)']);
  });
});
