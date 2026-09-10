import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { solveRequestAdmission } from '../client.js';
import { createRequestAdmission } from '../index.js';

const settings = { signingKey: 'synthetic-admission-key-32-characters-long', difficulty: 12 };
describe('request admission work', () => {
  it('binds a valid solution to its recipient/source/tenant and signing key', async () => {
    const admission = createRequestAdmission(settings);
    const challenge = admission.challenge('synthetic-tenant/recipient/source');
    const proof = await solveRequestAdmission(challenge);
    const digest = createHash('sha256').update(`${proof.token}:${proof.solution}`).digest();
    expect(digest[0]).toBe(0);
    expect((digest[1] ?? 255) & 0xf0).toBe(0);
    expect(admission.verify(proof, 'synthetic-tenant/recipient/source')).toMatch(/^[a-f0-9]{64}$/);
    expect(admission.verify(proof, 'another-tenant/recipient/source')).toBeUndefined();
    expect(admission.verify(proof, 'synthetic-tenant/another-recipient/source')).toBeUndefined();
    expect(admission.verify(proof, 'synthetic-tenant/recipient/another-source')).toBeUndefined();
    expect(
      createRequestAdmission({
        ...settings,
        signingKey: 'another-synthetic-key-32-characters-long',
      }).verify(proof, 'synthetic-tenant/recipient/source'),
    ).toBeUndefined();
  });
  it('allows a skewed client clock while the server still enforces expiry', async () => {
    const admission = createRequestAdmission(settings);
    const challenge = admission.challenge('synthetic');
    const proof = await solveRequestAdmission(challenge, {
      now: () => challenge.expiresAt + 60000,
    });
    expect(admission.verify(proof, 'synthetic')).toBeTruthy();
    expect(admission.verify(proof, 'synthetic', challenge.expiresAt)).toBeUndefined();
  });
  it('refuses forged, malformed and expired challenges', async () => {
    const admission = createRequestAdmission(settings);
    const challenge = admission.challenge('synthetic');
    const proof = await solveRequestAdmission(challenge);
    expect(admission.verify({ ...proof, token: `${proof.token}x` }, 'synthetic')).toBeUndefined();
    expect(admission.verify({ ...proof, solution: '-1' }, 'synthetic')).toBeUndefined();
    expect(admission.verify(proof, 'synthetic', challenge.expiresAt)).toBeUndefined();
    expect(
      admission.verify({ token: 'x'.repeat(3000), solution: '0' }, 'synthetic'),
    ).toBeUndefined();
    expect(admission.verify(undefined, 'synthetic')).toBeUndefined();
  });
  it('rejects a noncanonical ticket even when fresh work was computed for that spelling', async () => {
    const admission = createRequestAdmission(settings);
    const challenge = admission.challenge('synthetic');
    for (const suffix of ['.', '..ignored']) {
      const proof = await solveRequestAdmission({ ...challenge, token: challenge.token + suffix });
      expect(admission.verify(proof, 'synthetic')).toBeUndefined();
    }
  });
  it('yields to cancellation and refuses excessive client work', async () => {
    const challenge = createRequestAdmission(settings).challenge('synthetic');
    const controller = new AbortController();
    controller.abort();
    await expect(
      solveRequestAdmission(challenge, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(solveRequestAdmission({ ...challenge, difficulty: 30 })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(solveRequestAdmission(challenge, { maxDurationMs: 0 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
