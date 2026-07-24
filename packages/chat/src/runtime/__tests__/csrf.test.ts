import { describe, expect, it } from 'vitest';
import {
  csrfBindingFromAuth,
  issueCsrfToken,
  normalizeOrigin,
  originAllowed,
  verifyCsrfToken,
} from '../csrf.js';

describe('csrf', () => {
  const secret = 'test-secret-key';
  const bindingA = csrfBindingFromAuth({
    userId: 'user-a',
    roles: [],
    scopes: [],
    provider: 'test',
  });
  const bindingB = csrfBindingFromAuth({
    userId: 'user-b',
    roles: [],
    scopes: [],
    provider: 'test',
  });

  it('issues then verifies a token for the same binding', () => {
    const token = issueCsrfToken(secret, bindingA);
    expect(verifyCsrfToken(secret, bindingA, token)).toBe(true);
  });

  it('rejects a token verified against a different binding', () => {
    const token = issueCsrfToken(secret, bindingA);
    expect(verifyCsrfToken(secret, bindingB, token)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = issueCsrfToken(secret, bindingA);
    const dot = token.indexOf('.');
    const sig = token.slice(dot + 1);
    const flipped = sig.startsWith('a') ? `b${sig.slice(1)}` : `a${sig.slice(1)}`;
    const tampered = `${token.slice(0, dot + 1)}${flipped}`;
    expect(verifyCsrfToken(secret, bindingA, tampered)).toBe(false);
  });

  it('rejects a missing/blank token', () => {
    expect(verifyCsrfToken(secret, bindingA, undefined)).toBe(false);
  });

  it('originAllowed requires exact normalized origin match', () => {
    expect(originAllowed('https://app.example.com', 'https://app.example.com/')).toBe(true);
    expect(originAllowed('https://evil.example.com', 'https://app.example.com/')).toBe(false);
    expect(normalizeOrigin('https://app.example.com/path')).toBe('https://app.example.com');
  });
});
