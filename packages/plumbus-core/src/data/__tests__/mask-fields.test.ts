import { describe, expect, it } from 'vitest';
import { LOG_MASK_TOKEN, AUDIT_MASK_TOKEN, maskSensitiveValues } from '../mask-fields.js';

describe('maskSensitiveValues', () => {
  it('masks top-level keys', () => {
    const result = maskSensitiveValues({ email: 'a@b.com', name: 'Ada' }, ['email']);
    expect(result).toEqual({ email: LOG_MASK_TOKEN, name: 'Ada' });
  });

  it('masks nested object keys', () => {
    const result = maskSensitiveValues({ user: { ssn: '123-45-6789', name: 'Ada' } }, ['ssn']);
    expect(result).toEqual({ user: { ssn: LOG_MASK_TOKEN, name: 'Ada' } });
  });

  it('uses AUDIT_MASK_TOKEN when specified', () => {
    const result = maskSensitiveValues({ email: 'a@b.com' }, ['email'], AUDIT_MASK_TOKEN);
    expect(result).toEqual({ email: '***' });
  });
});
