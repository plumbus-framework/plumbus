import { describe, expectTypeOf, it } from 'vitest';
import { defineTranslation } from '../defineTranslation.js';
import type { TranslationDefinition } from '../../types/translation.js';

describe('defineTranslation — compile-time key consistency (positive)', () => {
  it('accepts matching 2-locale literal catalogs', () => {
    const translation = defineTranslation({
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

    expectTypeOf(translation).toEqualTypeOf<TranslationDefinition>();
  });

  it('accepts matching 3-locale literal catalogs', () => {
    const translation = defineTranslation({
      name: 'common',
      defaultLocale: 'en',
      locales: ['en', 'he', 'fr'],
      messages: {
        en: {
          greeting: 'Hello {name}',
          farewell: 'Goodbye',
        },
        he: {
          greeting: 'שלום {name}',
          farewell: 'להתראות',
        },
        fr: {
          greeting: 'Bonjour {name}',
          farewell: 'Au revoir',
        },
      },
    });

    expectTypeOf(translation).toEqualTypeOf<TranslationDefinition>();
  });

  it('accepts Record<string, string> locale as a dynamic escape hatch (runtime-checked)', () => {
    const he: Record<string, string> = {
      greeting: 'שלום {name}',
      farewell: 'להתראות',
    };

    const translation = defineTranslation({
      name: 'common',
      defaultLocale: 'en',
      locales: ['en', 'he'],
      messages: {
        en: {
          greeting: 'Hello {name}',
          farewell: 'Goodbye',
        },
        he,
      },
    });

    expectTypeOf(translation).toEqualTypeOf<TranslationDefinition>();
  });
});
