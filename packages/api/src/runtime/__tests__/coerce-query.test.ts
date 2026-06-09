import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceQueryParams } from '../coerce-query.js';

describe('coerceQueryParams', () => {
  it('coerces string query values to numbers', () => {
    const schema = z.object({ limit: z.number(), offset: z.number().optional() });
    const result = coerceQueryParams({ limit: '10', offset: '0' }, schema);
    expect(result).toEqual({ limit: 10, offset: 0 });
  });

  it('coerces string query values to booleans', () => {
    const schema = z.object({ active: z.boolean() });
    const result = coerceQueryParams({ active: 'true' }, schema);
    expect(result).toEqual({ active: true });
  });

  it('passes through non-string values unchanged', () => {
    const schema = z.object({ tag: z.string() });
    const result = coerceQueryParams({ tag: 'alpha' }, schema);
    expect(result).toEqual({ tag: 'alpha' });
  });
});
