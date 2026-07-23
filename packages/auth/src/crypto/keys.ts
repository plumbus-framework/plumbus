import { createHash, hkdfSync } from 'node:crypto';
import { resolveSecretSource, type SecretSource } from './secret-source.js';

export type { SecretSource };

export interface StorageProtectionConfig {
  activeKey: { id: string; value: SecretSource };
  decryptOnlyKeys?: Array<{ id: string; value: SecretSource }>;
}

export interface Keyring {
  applicationId: string;
  activeKeyId: string;
  subkeys: Record<string, Buffer>;
  keysById: Record<string, Buffer>;
}

const PURPOSES = [
  'session-id-hmac',
  'csrf-hmac',
  'state-hmac',
  'binding-hmac',
  'user-lookup-hmac',
  'envelope-aes',
] as const;

function decodeSecret(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[A-Fa-f0-9]+$/.test(trimmed) && trimmed.length >= 64) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const b64 = Buffer.from(trimmed, 'base64url');
    if (b64.length >= 32) return b64;
  } catch {
    // fall through
  }
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length >= 32) return b64;
  } catch {
    // fall through
  }
  const utf8 = Buffer.from(trimmed, 'utf8');
  if (utf8.length >= 32) return utf8;
  throw new Error('Storage protection key must decode to at least 32 bytes');
}

async function resolveSecret(source: SecretSource): Promise<Buffer> {
  const value = await resolveSecretSource(source);
  if (!value || value.trim().length === 0) {
    throw new Error('Storage protection key must not be empty');
  }
  return decodeSecret(value);
}

export async function resolveKeyring(
  cfg: StorageProtectionConfig,
  applicationId: string,
): Promise<Keyring> {
  const entries = [cfg.activeKey, ...(cfg.decryptOnlyKeys ?? [])];
  const seenIds = new Set<string>();
  const keysById: Record<string, Buffer> = {};

  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate storage protection key id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    keysById[entry.id] = await resolveSecret(entry.value);
  }

  const activeRoot = keysById[cfg.activeKey.id];
  if (!activeRoot) {
    throw new Error(`Active storage protection key "${cfg.activeKey.id}" is missing`);
  }
  const subkeys: Record<string, Buffer> = {};
  for (const purpose of PURPOSES) {
    subkeys[purpose] = Buffer.from(
      hkdfSync('sha256', activeRoot, applicationId, `plumbus-auth:${purpose}:v1`, 32),
    );
  }

  return {
    applicationId,
    activeKeyId: cfg.activeKey.id,
    subkeys,
    keysById,
  };
}

export function deriveSubkey(
  keyring: Keyring,
  keyId: string,
  purpose: (typeof PURPOSES)[number],
): Buffer {
  const root = keyring.keysById[keyId];
  if (!root) {
    throw new Error(`Unknown storage protection key id: ${keyId}`);
  }
  return Buffer.from(
    hkdfSync('sha256', root, keyring.applicationId, `plumbus-auth:${purpose}:v1`, 32),
  );
}

export function sha256CanonicalJson(value: Record<string, unknown>): string {
  const sorted = Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = value[key];
      return acc;
    }, {});
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
