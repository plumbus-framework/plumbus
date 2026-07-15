import { describe, expect, it } from 'vitest';
import { IntlErrorCode } from 'next-intl';
import {
  getMissingMessageFallback,
  onTranslationError,
  type MessageFallbackArgs,
} from '../index.js';

describe('getMissingMessageFallback', () => {
  it('returns a visible sentinel with namespace and key', () => {
    const args = {
      namespace: 'common',
      key: 'nav.home',
      error: { code: IntlErrorCode.MISSING_MESSAGE } as MessageFallbackArgs['error'],
    };
    expect(getMissingMessageFallback(args)).toBe('[missing: common.nav.home]');
  });

  it('omits empty namespace', () => {
    const args = {
      key: 'orphan',
      error: { code: IntlErrorCode.MISSING_MESSAGE } as MessageFallbackArgs['error'],
    };
    expect(getMissingMessageFallback(args)).toBe('[missing: orphan]');
  });
});

describe('onTranslationError', () => {
  it('logs without throwing', () => {
    expect(() =>
      onTranslationError({
        code: IntlErrorCode.MISSING_MESSAGE,
        message: 'missing',
      } as Parameters<typeof onTranslationError>[0]),
    ).not.toThrow();
  });
});
