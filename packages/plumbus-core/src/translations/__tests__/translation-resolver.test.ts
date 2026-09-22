import { describe, expect, it } from 'vitest';
import { defineTranslation } from '../../define/defineTranslation.js';
import {
  createTranslationResolver,
  createTranslationService,
  TranslationRegistry,
} from '../index.js';

const commonTranslation = defineTranslation({
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: {
      greeting: 'Hello {name}',
      farewell: 'Goodbye',
      items: '{count, plural, one {# item} other {# items}}',
      itemsWithZero: '{count, plural, zero {No items} one {# item} other {# items}}',
      role: '{gender, select, male {He is an admin} female {She is an admin} other {They are an admin}}',
    },
    he: {
      greeting: 'שלום {name}',
      farewell: 'להתראות',
      items: '{count, plural, one {פריט #} two {# פריטים} other {# פריטים}}',
      itemsWithZero: '{count, plural, zero {אין פריטים} one {פריט #} other {# פריטים}}',
      role: '{gender, select, male {הוא מנהל} female {היא מנהלת} other {מנהל/ת}}',
    },
  },
});

const errorsTranslation = defineTranslation({
  name: 'errors',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: {
      notFound: 'Not found',
      forbidden: 'Access denied',
    },
    he: {
      notFound: 'לא נמצא',
      forbidden: 'הגישה נדחתה',
    },
  },
});

describe('TranslationRegistry', () => {
  it('resolves simple key in requested locale', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('he', 'common.farewell')).toBe('להתראות');
  });

  it('resolves key with interpolation', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'common.greeting', { name: 'World' })).toBe('Hello World');
    expect(registry.t('he', 'common.greeting', { name: 'עולם' })).toBe('שלום עולם');
  });

  it('resolves plural — one', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'common.items', { count: 1 })).toBe('1 item');
  });

  it('resolves plural — other', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'common.items', { count: 5 })).toBe('5 items');
  });

  it('resolves plural — zero', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'common.itemsWithZero', { count: 0 })).toBe('No items');
  });

  it('resolves plural — Hebrew dual', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('he', 'common.items', { count: 2 })).toBe('2 פריטים');
  });

  it('resolves select', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'common.role', { gender: 'male' })).toBe('He is an admin');
    expect(registry.t('en', 'common.role', { gender: 'female' })).toBe('She is an admin');
    expect(registry.t('en', 'common.role', { gender: 'unknown' })).toBe('They are an admin');
  });

  it('falls back to default locale when requested locale is missing', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('fr', 'common.farewell')).toBe('Goodbye');
  });

  it('returns key as-is when namespace is unknown', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'unknown.key')).toBe('unknown.key');
  });

  it('returns key as-is when key has no namespace', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.t('en', 'plainkey')).toBe('plainkey');
  });

  it('registers multiple namespaces', () => {
    const registry = new TranslationRegistry();
    registry.registerAll([commonTranslation, errorsTranslation]);
    expect(registry.t('en', 'common.farewell')).toBe('Goodbye');
    expect(registry.t('he', 'errors.notFound')).toBe('לא נמצא');
  });

  it('getNamespaces returns all registered names', () => {
    const registry = new TranslationRegistry();
    registry.registerAll([commonTranslation, errorsTranslation]);
    expect(registry.getNamespaces().sort()).toEqual(['common', 'errors']);
  });

  it('getDefinition returns specific definition', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);
    expect(registry.getDefinition('common')?.name).toBe('common');
    expect(registry.getDefinition('unknown')).toBeUndefined();
  });

  it('getAllDefinitions returns all', () => {
    const registry = new TranslationRegistry();
    registry.registerAll([commonTranslation, errorsTranslation]);
    expect(registry.getAllDefinitions()).toHaveLength(2);
  });
});

describe('createTranslationResolver', () => {
  it('creates a resolver from definitions', () => {
    const resolver = createTranslationResolver([commonTranslation, errorsTranslation]);
    expect(resolver.t('en', 'common.farewell')).toBe('Goodbye');
    expect(resolver.t('he', 'errors.forbidden')).toBe('הגישה נדחתה');
  });
});

describe('createTranslationService', () => {
  it('creates a locale-bound service', () => {
    const registry = new TranslationRegistry();
    registry.registerAll([commonTranslation, errorsTranslation]);

    const service = createTranslationService(registry, 'he');
    expect(service.locale).toBe('he');
    expect(service.t('common.farewell')).toBe('להתראות');
    expect(service.t('errors.notFound')).toBe('לא נמצא');
  });

  it('locale-bound service still uses interpolation', () => {
    const registry = new TranslationRegistry();
    registry.register(commonTranslation);

    const service = createTranslationService(registry, 'en');
    expect(service.t('common.greeting', { name: 'Alice' })).toBe('Hello Alice');
  });
});
