import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  decryptFieldValue,
  encryptFieldValue,
  ENCRYPTION_PREFIX,
  getEncryptedFields,
  isEncryptedValue,
  resolveEncryptionKey,
} from '../field-encryption.js';
import { EncryptionConfigError, EncryptionPayloadError } from '../../errors/data-errors.js';

function testKey(): Buffer {
  return randomBytes(32);
}

describe('field encryption', () => {
  it('encrypts and decrypts round-trip', () => {
    const key = testKey();
    const ciphertext = encryptFieldValue('secret-value', key);
    expect(isEncryptedValue(ciphertext)).toBe(true);
    expect(decryptFieldValue(ciphertext, key)).toBe('secret-value');
  });

  it('passes through plaintext values on decrypt', () => {
    const key = testKey();
    expect(decryptFieldValue('legacy-plain', key)).toBe('legacy-plain');
  });

  it('uses the plumbus encryption prefix', () => {
    const key = testKey();
    expect(encryptFieldValue('x', key).startsWith(ENCRYPTION_PREFIX)).toBe(true);
  });

  it('resolves 64-char hex keys from env', () => {
    const hex = randomBytes(32).toString('hex');
    const key = resolveEncryptionKey({ PLUMBUS_ENCRYPTION_KEY: hex });
    expect(key?.equals(Buffer.from(hex, 'hex'))).toBe(true);
  });

  it('returns undefined when env key is missing', () => {
    expect(resolveEncryptionKey({})).toBeUndefined();
  });

  it('throws EncryptionConfigError for invalid key material', () => {
    expect(() => resolveEncryptionKey({ PLUMBUS_ENCRYPTION_KEY: 'not-a-key' })).toThrow(
      EncryptionConfigError,
    );
  });

  it('encrypts and decrypts empty string round-trip', () => {
    const key = testKey();
    const ciphertext = encryptFieldValue('', key);
    expect(decryptFieldValue(ciphertext, key)).toBe('');
  });

  it('lists encrypted string fields on an entity', () => {
    const entity: EntityDefinition = {
      name: 'SecretDoc',
      fields: {
        id: field.id(),
        note: field.string({ encrypted: true }),
        title: field.string(),
      },
    };
    expect(getEncryptedFields(entity)).toEqual(['note']);
  });

  it('throws EncryptionPayloadError when ciphertext is tampered', () => {
    const key = testKey();
    const ciphertext = encryptFieldValue('secret', key);
    const payload = ciphertext.slice(ENCRYPTION_PREFIX.length);
    const tampered = `${ENCRYPTION_PREFIX}${payload.slice(0, -4)}AAAA`;
    expect(() => decryptFieldValue(tampered, key)).toThrow(EncryptionPayloadError);
  });
});
