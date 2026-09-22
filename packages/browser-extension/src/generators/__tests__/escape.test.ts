import { describe, expect, it } from 'vitest';
import { escapeHtmlText, escapeJsxText } from '../escape.js';

describe('escapeHtmlText', () => {
  it('escapes HTML metacharacters but not braces', () => {
    expect(escapeHtmlText('Acme {Beta}')).toBe('Acme {Beta}');
    expect(escapeHtmlText('<script>')).toBe('&lt;script&gt;');
  });
});

describe('escapeJsxText', () => {
  it('escapes braces for JSX text nodes', () => {
    expect(escapeJsxText('Acme {Beta}')).toBe('Acme &lbrace;Beta&rbrace;');
  });

  it('still escapes HTML metacharacters', () => {
    expect(escapeJsxText('<x>')).toBe('&lt;x&gt;');
  });
});
