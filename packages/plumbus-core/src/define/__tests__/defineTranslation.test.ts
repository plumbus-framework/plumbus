import { describe, expect, it } from 'vitest';
import { defineTranslation } from '../defineTranslation.js';

describe('defineTranslation', () => {
  const validConfig = () => ({
    name: 'common',
    defaultLocale: 'en',
    locales: ['en', 'he'],
    messages: {
      en: {
        greeting: 'Hello {name}',
        farewell: 'Goodbye',
      },
      he: {
        greeting: 'שלום {name}',
        farewell: 'להתראות',
      },
    },
  });

  it('creates a valid translation definition', () => {
    const translation = defineTranslation(validConfig());
    expect(translation.name).toBe('common');
    expect(translation.defaultLocale).toBe('en');
    expect(translation.locales).toEqual(['en', 'he']);
  });

  it('freezes the returned definition', () => {
    const translation = defineTranslation(validConfig());
    expect(Object.isFrozen(translation)).toBe(true);
  });

  it('throws if name is missing', () => {
    expect(() => defineTranslation({ ...validConfig(), name: '' })).toThrow(
      'Translation name is required',
    );
  });

  it('throws if defaultLocale is missing', () => {
    expect(() => defineTranslation({ ...validConfig(), defaultLocale: '' })).toThrow(
      'defaultLocale is required',
    );
  });

  it('throws if locales is empty', () => {
    expect(() => defineTranslation({ ...validConfig(), locales: [] })).toThrow(
      'locales must be a non-empty array',
    );
  });

  it('throws if defaultLocale is not in locales', () => {
    expect(() => defineTranslation({ ...validConfig(), defaultLocale: 'fr' })).toThrow(
      'defaultLocale "fr" must be included in locales',
    );
  });

  it('throws if a declared locale is missing messages', () => {
    expect(() =>
      defineTranslation({
        ...validConfig(),
        locales: ['en', 'he', 'fr'],
      }),
    ).toThrow('missing messages for declared locale "fr"');
  });

  it('throws if a locale is missing keys', () => {
    expect(() =>
      defineTranslation({
        ...validConfig(),
        messages: {
          en: { greeting: 'Hello', farewell: 'Goodbye' },
          he: { greeting: 'שלום' },
        },
      }),
    ).toThrow('locale "he" is missing keys: ["farewell"]');
  });

  it('throws if a locale has extra keys', () => {
    expect(() =>
      defineTranslation({
        ...validConfig(),
        messages: {
          en: { greeting: 'Hello' },
          he: { greeting: 'שלום', extra: 'תוספת' },
        },
      }),
    ).toThrow('locale "he" has extra keys not in default locale: ["extra"]');
  });

  it('accepts single-locale definition', () => {
    const translation = defineTranslation({
      name: 'simple',
      defaultLocale: 'en',
      locales: ['en'],
      messages: {
        en: { hello: 'Hello' },
      },
    });
    expect(translation.name).toBe('simple');
  });

  it('accepts three or more locales', () => {
    const translation = defineTranslation({
      name: 'multi',
      defaultLocale: 'en',
      locales: ['en', 'he', 'fr'],
      messages: {
        en: { hello: 'Hello' },
        he: { hello: 'שלום' },
        fr: { hello: 'Bonjour' },
      },
    });
    expect(translation.locales).toHaveLength(3);
  });
});
