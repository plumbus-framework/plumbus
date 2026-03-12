import { describe, expect, it } from 'vitest';
import { formatOutput, toCamelCase, toKebabCase, toPascalCase } from '../utils.js';

describe('CLI utilities', () => {
  describe('toKebabCase', () => {
    it('converts PascalCase', () => expect(toKebabCase('MyApp')).toBe('my-app'));
    it('converts camelCase', () => expect(toKebabCase('myApp')).toBe('my-app'));
    it('converts spaces', () => expect(toKebabCase('My App')).toBe('my-app'));
    it('converts underscores', () => expect(toKebabCase('my_app')).toBe('my-app'));
    it('handles already kebab', () => expect(toKebabCase('my-app')).toBe('my-app'));
  });

  describe('toPascalCase', () => {
    it('converts kebab-case', () => expect(toPascalCase('my-app')).toBe('MyApp'));
    it('converts snake_case', () => expect(toPascalCase('my_app')).toBe('MyApp'));
    it('converts spaces', () => expect(toPascalCase('my app')).toBe('MyApp'));
  });

  describe('toCamelCase', () => {
    it('converts kebab-case', () => expect(toCamelCase('my-app')).toBe('myApp'));
    it('converts PascalCase', () => expect(toCamelCase('MyApp')).toBe('myApp'));
  });

  describe('formatOutput', () => {
    it('returns JSON when json option is true', () => {
      const result = formatOutput({ foo: 'bar' }, { json: true });
      expect(JSON.parse(result)).toEqual({ foo: 'bar' });
    });

    it('returns string directly', () => {
      expect(formatOutput('hello', {})).toBe('hello');
    });
  });
});
