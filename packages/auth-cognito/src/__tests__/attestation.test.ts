import { describe, expect, it } from 'vitest';
import {
  parseAttestationKeys,
  signAttestation,
  validateAttestationKeys,
  verifyAttestation,
} from '../attestation/index.js';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(40);
const KEYS = [{ id: 'k1', secret: SECRET_A }];
const SUBJECT = { userPoolId: 'eu-west-1_Pool1', username: 'account-1', nonce: 'nonce-1' };

describe('attestation', () => {
  it('signs with the first key and verifies the same subject', () => {
    const answer = signAttestation(KEYS, SUBJECT);
    expect(answer).toMatch(/^v1\.k1\.[A-Za-z0-9_-]+$/);
    expect(verifyAttestation(KEYS, SUBJECT, answer)).toBe(true);
  });

  it('binds the answer to pool, user and nonce', () => {
    const answer = signAttestation(KEYS, SUBJECT);
    expect(verifyAttestation(KEYS, { ...SUBJECT, userPoolId: 'eu-west-1_Pool2' }, answer)).toBe(
      false,
    );
    expect(verifyAttestation(KEYS, { ...SUBJECT, username: 'account-2' }, answer)).toBe(false);
    expect(verifyAttestation(KEYS, { ...SUBJECT, nonce: 'nonce-2' }, answer)).toBe(false);
  });

  it('verifies with any keyring key, so a rotation can overlap', () => {
    const oldAnswer = signAttestation([{ id: 'old', secret: SECRET_A }], SUBJECT);
    const rotated = [
      { id: 'new', secret: SECRET_B },
      { id: 'old', secret: SECRET_A },
    ];
    expect(verifyAttestation(rotated, SUBJECT, oldAnswer)).toBe(true);
    expect(signAttestation(rotated, SUBJECT).startsWith('v1.new.')).toBe(true);
    expect(verifyAttestation([{ id: 'new', secret: SECRET_B }], SUBJECT, oldAnswer)).toBe(false);
  });

  it('answers false, never throws, for malformed or forged answers', () => {
    const answer = signAttestation(KEYS, SUBJECT);
    const forged = `${answer.slice(0, -2)}AA`;
    for (const candidate of [
      undefined,
      42,
      '',
      'v1.k1',
      'v2.k1.abc',
      'v1.unknown.abc',
      forged,
      'x'.repeat(300),
    ]) {
      expect(verifyAttestation(KEYS, SUBJECT, candidate)).toBe(false);
    }
    expect(verifyAttestation(KEYS, { ...SUBJECT, nonce: '' }, answer)).toBe(false);
  });

  it('refuses weak or duplicate keys', () => {
    expect(() => validateAttestationKeys([])).toThrow(/at least one/);
    expect(() => validateAttestationKeys([{ id: 'k1', secret: 'short' }])).toThrow(/32/);
    expect(() => validateAttestationKeys([{ id: 'bad id', secret: SECRET_A }])).toThrow(/key id/);
    expect(() =>
      validateAttestationKeys([
        { id: 'k1', secret: SECRET_A },
        { id: 'k1', secret: SECRET_B },
      ]),
    ).toThrow(/duplicate/);
    expect(() => signAttestation(KEYS, { ...SUBJECT, username: '' })).toThrow(/username/);
  });

  it('parses an environment keyring, signing key first', () => {
    const keys = parseAttestationKeys(` new:${SECRET_B}:with-colon , old:${SECRET_A}`);
    expect(keys.map((key) => key.id)).toEqual(['new', 'old']);
    expect(keys[0]?.secret).toBe(`${SECRET_B}:with-colon`);
    expect(Object.isFrozen(keys)).toBe(true);
    expect(() => parseAttestationKeys('')).toThrow(/at least one/);
    expect(() => parseAttestationKeys('no-separator')).toThrow(/id:secret/);
  });
});
