import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export interface PasswordHashOptions {
  saltBytes?: number;
  keyLength?: number;
}

const defaultPasswordHashOptions: Required<PasswordHashOptions> = {
  saltBytes: 16,
  keyLength: 64,
};

/**
 * Hash a password with scrypt and return a portable salt:hash string.
 */
export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {},
): Promise<string> {
  const resolved = { ...defaultPasswordHashOptions, ...options };
  const salt = randomBytes(resolved.saltBytes).toString('hex');
  const derived = (await scryptAsync(password, salt, resolved.keyLength)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored salt:hash string.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  options: PasswordHashOptions = {},
): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) {
    return false;
  }

  const resolved = { ...defaultPasswordHashOptions, ...options };
  const derived = (await scryptAsync(password, salt, resolved.keyLength)) as Buffer;
  const stored = Buffer.from(hash, 'hex');

  if (stored.length !== derived.length) {
    return false;
  }

  return timingSafeEqual(derived, stored);
}
