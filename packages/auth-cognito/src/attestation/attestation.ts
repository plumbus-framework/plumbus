import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One key of the shared attestation keyring.
 *
 * The first key of a keyring signs; every key verifies. Rotation is therefore two deploys: add
 * the new key second everywhere, then move it first once every signer and verifier holds it.
 */
export interface AttestationKey {
  /** Short public key id carried in every answer, so a verifier picks the key without trying all. */
  readonly id: string;
  /** Shared secret. At least 32 characters; never logged, never sent to Cognito. */
  readonly secret: string;
}

/** Everything an answer is bound to. A proof for one pool, user or challenge fits no other. */
export interface AttestationSubject {
  readonly userPoolId: string;
  readonly username: string;
  readonly nonce: string;
}

/** Challenge metadata the define trigger requires on the one challenge it accepts. */
export const ATTESTATION_CHALLENGE_METADATA = 'PLUMBUS_ATTESTED_V1';

const ANSWER_VERSION = 'v1';
const DOMAIN = 'plumbus-cognito-attested-v1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_SECRET_LENGTH = 32;

function assertKey(key: AttestationKey): void {
  if (!KEY_ID_PATTERN.test(key.id)) {
    throw new TypeError('attestation key id must be 1-32 characters of [A-Za-z0-9_-]');
  }
  if (typeof key.secret !== 'string' || key.secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`attestation key secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

/**
 * Checks a keyring and returns it frozen: non-empty, well-formed, no duplicate ids.
 */
export function validateAttestationKeys(
  keys: readonly AttestationKey[],
): readonly AttestationKey[] {
  if (keys.length === 0) throw new TypeError('at least one attestation key is required');
  const seen = new Set<string>();
  for (const key of keys) {
    assertKey(key);
    if (seen.has(key.id)) throw new TypeError(`duplicate attestation key id: ${key.id}`);
    seen.add(key.id);
  }
  return Object.freeze(keys.map((key) => Object.freeze({ id: key.id, secret: key.secret })));
}

/**
 * Parses a keyring from one environment value: `id:secret[,id:secret…]`, signing key first.
 *
 * Secrets may contain `:` (only the first one separates); they may not contain `,`.
 */
export function parseAttestationKeys(value: string | undefined): readonly AttestationKey[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const keys = entries.map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new TypeError('attestation keys must be written as id:secret');
    return { id: entry.slice(0, separator), secret: entry.slice(separator + 1) };
  });
  return validateAttestationKeys(keys);
}

/** A fresh challenge nonce: 32 random bytes, base64url. */
export function createAttestationNonce(): string {
  return randomBytes(32).toString('base64url');
}

function mac(secret: string, subject: AttestationSubject): Buffer {
  return createHmac('sha256', secret)
    .update(`${DOMAIN}\n${subject.userPoolId}\n${subject.username}\n${subject.nonce}`)
    .digest();
}

function assertSubject(subject: AttestationSubject): void {
  if (!subject.userPoolId || !subject.username || !subject.nonce) {
    throw new TypeError('attestation needs a user pool id, a username and a nonce');
  }
}

/** Signs a challenge answer with the keyring's first key: `v1.<keyId>.<base64url mac>`. */
export function signAttestation(
  keys: readonly AttestationKey[],
  subject: AttestationSubject,
): string {
  assertSubject(subject);
  const signing = keys[0];
  if (!signing) throw new TypeError('at least one attestation key is required');
  assertKey(signing);
  return `${ANSWER_VERSION}.${signing.id}.${mac(signing.secret, subject).toString('base64url')}`;
}

/**
 * Whether `answer` is a valid attestation for `subject` under any key of the keyring.
 *
 * Never throws on a malformed answer: the verify trigger answers "incorrect", not "error".
 */
export function verifyAttestation(
  keys: readonly AttestationKey[],
  subject: AttestationSubject,
  answer: unknown,
): boolean {
  if (typeof answer !== 'string' || answer.length > 256) return false;
  if (!subject.userPoolId || !subject.username || !subject.nonce) return false;
  const parts = answer.split('.');
  if (parts.length !== 3 || parts[0] !== ANSWER_VERSION) return false;
  const [, keyId, presented] = parts;
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key || !presented) return false;
  const expected = mac(key.secret, subject);
  const received = Buffer.from(presented, 'base64url');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
