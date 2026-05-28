import { describe, expect, it } from 'vitest';
import { scopeToRetrieveFilter } from '../to-retrieve-filter.js';

describe('scopeToRetrieveFilter', () => {
  it('flattens scope dimensions', () => {
    expect(
      scopeToRetrieveFilter({
        audience: 'user',
        locale: 'en',
        tenantId: 't1',
        custom: { projectId: 'abc' },
      }),
    ).toEqual({
      audience: 'user',
      locale: 'en',
      tenantId: 't1',
      projectId: 'abc',
    });
  });
});
