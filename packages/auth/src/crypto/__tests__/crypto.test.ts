import { describe, expect, it } from 'vitest';
import { EnvelopeError, open, seal } from '../envelope.js';
import { constantTimeEqual, hmacLookup } from '../lookup.js';
import { resolveKeyring } from '../keys.js';
import { createStorageProtection } from '../protection.js';
import { randomToken } from '../random.js';

const TEST_KEY = randomToken();

describe('crypto', () => {
  it('roundtrips envelope encryption', async () => {
    const keyring = await resolveKeyring({ activeKey: { id: 'k1', value: TEST_KEY } }, 'app-1');
    const aad = {
      applicationId: 'app-1',
      recordType: 'session-principal',
      schemaVersion: 1,
      recordRef: 'ref-1',
    };
    const envelope = seal(keyring.subkeys['envelope-aes'], '{"userId":"u1"}', aad, 'k1');
    expect(open(keyring, envelope, aad)).toBe('{"userId":"u1"}');
  });

  it('supports key rotation for open', async () => {
    const oldKey = randomToken();
    const newKey = randomToken();
    const keyringOld = await resolveKeyring({ activeKey: { id: 'old', value: oldKey } }, 'app-1');
    const aad = {
      applicationId: 'app-1',
      recordType: 'login-transaction',
      schemaVersion: 1,
      recordRef: 'tx-1',
    };
    const envelope = seal(keyringOld.subkeys['envelope-aes'], '{"state":"abc"}', aad, 'old');
    const keyringNew = await resolveKeyring(
      {
        activeKey: { id: 'new', value: newKey },
        decryptOnlyKeys: [{ id: 'old', value: oldKey }],
      },
      'app-1',
    );
    expect(open(keyringNew, envelope, aad)).toBe('{"state":"abc"}');
    const resealed = seal(keyringNew.subkeys['envelope-aes'], '{"state":"abc"}', aad, 'new');
    expect(resealed.includes('.new.')).toBe(true);
  });

  it('rejects tampered envelopes', async () => {
    const keyring = await resolveKeyring({ activeKey: { id: 'k1', value: TEST_KEY } }, 'app-1');
    const aad = {
      applicationId: 'app-1',
      recordType: 'session-principal',
      schemaVersion: 1,
      recordRef: 'ref-1',
    };
    const envelope = seal(keyring.subkeys['envelope-aes'], '{"userId":"u1"}', aad, 'k1');
    const parts = envelope.split('.');
    const flip = (part: string) => {
      const buf = Buffer.from(part, 'base64url');
      if (buf.length > 0) buf[0] = buf[0] === 0 ? 1 : 0;
      return buf.toString('base64url');
    };

    expect(() =>
      open(keyring, envelope.replace(parts[3] ?? '', flip(parts[3] ?? '')), aad),
    ).toThrow(EnvelopeError);
    expect(() =>
      open(keyring, envelope.replace(parts[4] ?? '', flip(parts[4] ?? '')), aad),
    ).toThrow(EnvelopeError);
    expect(() =>
      open(keyring, envelope.replace(parts[5] ?? '', flip(parts[5] ?? '')), aad),
    ).toThrow(EnvelopeError);
    expect(() => open(keyring, envelope.replace('.k1.', '.missing.'), aad)).toThrow(EnvelopeError);
  });

  it('rejects envelopes with short GCM tags or nonces', async () => {
    const keyring = await resolveKeyring({ activeKey: { id: 'k1', value: TEST_KEY } }, 'app-1');
    const aad = {
      applicationId: 'app-1',
      recordType: 'session-principal',
      schemaVersion: 1,
      recordRef: 'ref-1',
    };
    const envelope = seal(keyring.subkeys['envelope-aes'], '{"userId":"u1"}', aad, 'k1');
    const parts = envelope.split('.');
    const shortTag = Buffer.alloc(4, 1).toString('base64url');
    const shortNonce = Buffer.alloc(8, 2).toString('base64url');
    expect(() => open(keyring, envelope.replace(parts[3] ?? '', shortNonce), aad)).toThrow(
      /nonce length/,
    );
    expect(() => open(keyring, envelope.replace(parts[5] ?? '', shortTag), aad)).toThrow(
      /tag length/,
    );
  });

  it('validates protection keys and hmac helpers', async () => {
    const protection = await createStorageProtection(
      { activeKey: { id: 'k1', value: TEST_KEY } },
      { applicationId: 'app-1', environment: 'production' },
    );
    expect(protection.hmac('session-id-hmac', 'secret')).toEqual(
      protection.hmac('session-id-hmac', 'secret'),
    );
    expect(protection.hmac('csrf-hmac', 'secret')).not.toEqual(
      protection.hmac('session-id-hmac', 'secret'),
    );
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(hmacLookup(Buffer.alloc(32, 1), 'value')).toBeTruthy();
    await expect(
      resolveKeyring({ activeKey: { id: 'k1', value: 'short' } }, 'app-1'),
    ).rejects.toThrow(/32 bytes/);
    await expect(
      resolveKeyring(
        {
          activeKey: { id: 'dup', value: TEST_KEY },
          decryptOnlyKeys: [{ id: 'dup', value: randomToken() }],
        },
        'app-1',
      ),
    ).rejects.toThrow(/Duplicate/);
  });
});
