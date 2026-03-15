import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../password.js';

describe('password helpers', () => {
  it('hashes passwords into salt:hash format', async () => {
    const hashed = await hashPassword('correct horse battery staple');
    const parts = hashed.split(':');

    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(32);
    expect(parts[1]?.length).toBeGreaterThan(0);
  });

  it('verifies the original password', async () => {
    const password = 'correct horse battery staple';
    const hashed = await hashPassword(password);

    await expect(verifyPassword(password, hashed)).resolves.toBe(true);
  });

  it('rejects an invalid password', async () => {
    const hashed = await hashPassword('correct horse battery staple');

    await expect(verifyPassword('wrong password', hashed)).resolves.toBe(false);
  });

  it('rejects malformed stored hashes', async () => {
    await expect(verifyPassword('password', 'not-a-valid-hash')).resolves.toBe(false);
  });

  it('supports custom key length options', async () => {
    const password = 'custom-options-password';
    const hashed = await hashPassword(password, { keyLength: 32, saltBytes: 8 });

    await expect(verifyPassword(password, hashed, { keyLength: 32 })).resolves.toBe(true);
    await expect(verifyPassword(password, hashed)).resolves.toBe(false);
  });
});
