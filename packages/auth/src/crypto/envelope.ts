import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveSubkey, type Keyring } from './keys.js';

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export interface EnvelopeAad {
  applicationId: string;
  recordType: string;
  schemaVersion: number;
  recordRef: string;
}

function canonicalAad(aad: EnvelopeAad): Buffer {
  const sorted = Object.keys(aad)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = aad[key as keyof EnvelopeAad];
      return acc;
    }, {});
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

export function seal(subkey: Buffer, plaintext: string, aad: EnvelopeAad, keyId: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', subkey, nonce);
  cipher.setAAD(canonicalAad(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    'gcm',
    keyId,
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export function open(keyring: Keyring, envelope: string, aad: EnvelopeAad): string {
  const parts = envelope.split('.');
  if (parts.length !== 6) {
    throw new EnvelopeError('Invalid envelope format');
  }

  const [version, alg, keyId, nonceB64, ctB64, tagB64] = parts;
  if (version !== 'v1' || alg !== 'gcm') {
    throw new EnvelopeError('Unsupported envelope version or algorithm');
  }
  if (!keyId || !nonceB64 || !ctB64 || !tagB64) {
    throw new EnvelopeError('Invalid envelope fields');
  }

  const rootKey = keyring.keysById[keyId];
  if (!rootKey) {
    throw new EnvelopeError('Unknown envelope key id');
  }

  let nonce: Buffer;
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    nonce = Buffer.from(nonceB64, 'base64url');
    ciphertext = Buffer.from(ctB64, 'base64url');
    tag = Buffer.from(tagB64, 'base64url');
  } catch {
    throw new EnvelopeError('Invalid envelope encoding');
  }
  if (nonce.length !== 12) {
    throw new EnvelopeError('Invalid envelope nonce length');
  }
  if (tag.length !== 16) {
    throw new EnvelopeError('Invalid envelope tag length');
  }

  const subkey = deriveSubkey(keyring, keyId, 'envelope-aes');
  const decipher = createDecipheriv('aes-256-gcm', subkey, nonce, { authTagLength: 16 });
  decipher.setAAD(canonicalAad(aad));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new EnvelopeError('Envelope authentication failed');
  }
}
