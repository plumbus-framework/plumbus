import { describe, expect, it } from 'vitest';
import { parseCookieHeader } from '../cookies.js';

describe('parseCookieHeader', () => {
  it('returns empty object for undefined header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('returns empty object for empty header', () => {
    expect(parseCookieHeader('')).toEqual({});
  });

  it('parses multiple cookies', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('skips pairs without equals sign', () => {
    expect(parseCookieHeader('a=1; broken; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('url-decodes values', () => {
    expect(parseCookieHeader('token=hello%20world')).toEqual({ token: 'hello world' });
  });

  it('keeps raw value when decode fails', () => {
    expect(parseCookieHeader('token=%ZZ')).toEqual({ token: '%ZZ' });
  });

  it('uses first occurrence when duplicate names appear', () => {
    expect(parseCookieHeader('a=first; a=second')).toEqual({ a: 'first' });
  });
});
