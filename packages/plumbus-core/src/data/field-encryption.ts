import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EncryptionConfigError, EncryptionPayloadError } from '../errors/data-errors.js';
import type { EntityDefinition } from '../types/entity.js';

export const ENCRYPTION_PREFIX = 'plumbus:enc:v1:';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Resolve a 32-byte AES-256 key from `PLUMBUS_ENCRYPTION_KEY`.
 * Accepts 64-char hex or base64/base64url encoding.
 */
export function resolveEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): Buffer | undefined {
  const raw = env.PLUMBUS_ENCRYPTION_KEY?.trim();
  if (!raw) return undefined;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const key = Buffer.from(raw, 'base64url');
    if (key.length === 32) return key;
  } catch {
    // fall through
  }

  try {
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
  } catch {
    // fall through
  }

  throw new EncryptionConfigError(
    'PLUMBUS_ENCRYPTION_KEY must be 32 bytes encoded as 64-char hex or base64/base64url',
  );
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

/**
 * AES-256-GCM over raw bytes. Packed layout is `iv (12) || authTag (16) || ciphertext`.
 * Field encryption and export envelope wrapping both use this; do not reimplement it in apps.
 */
export function encryptBytes(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Inverse of {@link encryptBytes}. Throws {@link EncryptionPayloadError} on truncation or tamper. */
export function decryptBytes(packed: Buffer, key: Buffer): Buffer {
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new EncryptionPayloadError('Invalid encrypted payload');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EncryptionPayloadError('Failed to decrypt payload');
  }
}

/** Encrypt a string field value. Returns ciphertext prefixed with `plumbus:enc:v1:`. */
export function encryptFieldValue(plaintext: string, key: Buffer): string {
  const payload = encryptBytes(Buffer.from(plaintext, 'utf8'), key);
  return `${ENCRYPTION_PREFIX}${payload.toString('base64url')}`;
}

/**
 * Decrypt a stored field value. Plaintext values (no prefix) pass through unchanged.
 */
export function decryptFieldValue(value: string, key: Buffer): string {
  if (!isEncryptedValue(value)) {
    return value;
  }

  const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64url');
  try {
    return decryptBytes(payload, key).toString('utf8');
  } catch (err) {
    if (err instanceof EncryptionPayloadError) {
      throw new EncryptionPayloadError('Failed to decrypt encrypted field value');
    }
    throw err;
  }
}

/** Extract string field names marked `encrypted: true` on an entity definition. */
export function getEncryptedFields(entity: EntityDefinition): string[] {
  const encrypted: string[] = [];
  for (const [name, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.type === 'string' && descriptor.options.encrypted) {
      encrypted.push(name);
    }
  }
  return encrypted;
}
