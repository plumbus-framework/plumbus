import { randomBytes } from 'node:crypto';
import { open, seal, type EnvelopeAad } from './envelope.js';
import { hmacLookup } from './lookup.js';
import {
  resolveKeyring,
  type Keyring,
  type SecretSource,
  type StorageProtectionConfig,
} from './keys.js';

export interface StorageProtection {
  applicationId: string;
  keyring: Keyring;
  sealJson(recordType: string, schemaVersion: number, recordRef: string, value: unknown): string;
  openJson(recordType: string, schemaVersion: number, recordRef: string, envelope: string): unknown;
  hmac(
    purpose: 'session-id-hmac' | 'csrf-hmac' | 'state-hmac' | 'binding-hmac' | 'user-lookup-hmac',
    value: string,
  ): string;
}

function aad(
  applicationId: string,
  recordType: string,
  schemaVersion: number,
  recordRef: string,
): EnvelopeAad {
  return { applicationId, recordType, schemaVersion, recordRef };
}

export async function createStorageProtection(
  cfg: StorageProtectionConfig | undefined,
  opts: { applicationId: string; environment: string },
): Promise<StorageProtection> {
  let config = cfg;
  if (!config) {
    if (opts.environment !== 'development') {
      throw new Error('Storage protection configuration is required outside development');
    }
    const ephemeral = randomBytes(32).toString('base64url');
    config = { activeKey: { id: 'dev-ephemeral', value: ephemeral } };
  }

  const keyring = await resolveKeyring(config, opts.applicationId);

  return {
    applicationId: opts.applicationId,
    keyring,
    sealJson(recordType, schemaVersion, recordRef, value) {
      const plaintext = JSON.stringify(value);
      const subkey = keyring.subkeys['envelope-aes'];
      if (!subkey) {
        throw new Error('Missing envelope encryption subkey');
      }
      return seal(
        subkey,
        plaintext,
        aad(opts.applicationId, recordType, schemaVersion, recordRef),
        keyring.activeKeyId,
      );
    },
    openJson(recordType, schemaVersion, recordRef, envelope) {
      const plaintext = open(
        keyring,
        envelope,
        aad(opts.applicationId, recordType, schemaVersion, recordRef),
      );
      return JSON.parse(plaintext) as unknown;
    },
    hmac(purpose, value) {
      const subkey = keyring.subkeys[purpose];
      if (!subkey) {
        throw new Error(`Missing HMAC subkey for ${purpose}`);
      }
      return hmacLookup(subkey, value);
    },
  };
}

export type { SecretSource, StorageProtectionConfig };
