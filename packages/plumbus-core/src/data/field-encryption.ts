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

/** Encrypt a string field value. Returns ciphertext prefixed with `plumbus:enc:v1:`. */
export function encryptFieldValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
  return `${ENCRYPTION_PREFIX}${payload}`;
}

/**
 * Decrypt a stored field value. Plaintext values (no prefix) pass through unchanged.
 */
export function decryptFieldValue(value: string, key: Buffer): string {
  if (!isEncryptedValue(value)) {
    return value;
  }

  const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64url');
  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new EncryptionPayloadError('Invalid encrypted field payload');
  }

  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new EncryptionPayloadError('Failed to decrypt encrypted field value');
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
