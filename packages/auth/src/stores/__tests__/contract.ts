import { describe, expect, it } from 'vitest';
import type {
  LoginTransactionStore,
  ProtectedLoginTransaction,
  ProtectedSessionRecord,
  SessionStore,
} from '../types.js';

export function describeSessionStoreContract(name: string, makeStore: () => SessionStore): void {
  describe(`session store contract (${name})`, () => {
    it('create/get roundtrip', async () => {
      const store = makeStore();
      const record: ProtectedSessionRecord = {
        applicationId: 'app-1',
        sessionRef: 'ref-1',
        sessionIdHash: 'hash-1',
        userLookup: 'user-1',
        principalEnvelope: 'env-1',
        csrfHash: 'csrf-1',
        schemaVersion: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-02T00:00:00.000Z'),
      };
      await store.create(record);
      await expect(
        store.getByIdHash({ applicationId: 'app-1', sessionIdHash: 'hash-1' }),
      ).resolves.toEqual(record);
    });

    it('get unknown returns null', async () => {
      const store = makeStore();
      await expect(
        store.getByIdHash({ applicationId: 'app-1', sessionIdHash: 'missing' }),
      ).resolves.toBeNull();
    });

    it('delete returns true/false', async () => {
      const store = makeStore();
      const record: ProtectedSessionRecord = {
        applicationId: 'app-1',
        sessionRef: 'ref-1',
        sessionIdHash: 'hash-1',
        userLookup: 'user-1',
        principalEnvelope: 'env-1',
        csrfHash: 'csrf-1',
        schemaVersion: 1,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      };
      await store.create(record);
      await expect(
        store.deleteByIdHash({ applicationId: 'app-1', sessionIdHash: 'hash-1' }),
      ).resolves.toBe(true);
      await expect(
        store.deleteByIdHash({ applicationId: 'app-1', sessionIdHash: 'hash-1' }),
      ).resolves.toBe(false);
    });

    it('evictOldestForUser keeps newest rows', async () => {
      const store = makeStore();
      for (let i = 0; i < 3; i++) {
        await store.create({
          applicationId: 'app-1',
          sessionRef: `ref-${i}`,
          sessionIdHash: `hash-${i}`,
          userLookup: 'user-1',
          principalEnvelope: 'env',
          csrfHash: 'csrf',
          schemaVersion: 1,
          createdAt: new Date(Date.now() + i * 1000),
          expiresAt: new Date(Date.now() + 60_000),
        });
      }
      await expect(
        store.evictOldestForUser({ applicationId: 'app-1', userLookup: 'user-1', keep: 2 }),
      ).resolves.toBe(1);
      await expect(
        store.countForUser({ applicationId: 'app-1', userLookup: 'user-1' }),
      ).resolves.toBe(2);
    });

    it('deleteExpired removes expired rows', async () => {
      const store = makeStore();
      await store.create({
        applicationId: 'app-1',
        sessionRef: 'ref-old',
        sessionIdHash: 'hash-old',
        userLookup: 'user-1',
        principalEnvelope: 'env',
        csrfHash: 'csrf',
        schemaVersion: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-01T01:00:00.000Z'),
      });
      await expect(store.deleteExpired(new Date('2026-01-01T01:00:00.000Z'))).resolves.toBe(1);
    });

    it('isolates application namespaces', async () => {
      const store = makeStore();
      await store.create({
        applicationId: 'app-a',
        sessionRef: 'ref',
        sessionIdHash: 'shared-hash',
        userLookup: 'user',
        principalEnvelope: 'env',
        csrfHash: 'csrf',
        schemaVersion: 1,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        store.getByIdHash({ applicationId: 'app-b', sessionIdHash: 'shared-hash' }),
      ).resolves.toBeNull();
    });
  });
}

export function describeLoginTransactionStoreContract(
  name: string,
  makeStore: () => LoginTransactionStore,
): void {
  describe(`login transaction store contract (${name})`, () => {
    const baseRecord = (): ProtectedLoginTransaction => ({
      applicationId: 'app-1',
      stateHash: 'state-1',
      browserBindingHash: 'bind-1',
      providerId: 'cognito',
      payloadEnvelope: 'env-1',
      schemaVersion: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T01:00:00.000Z'),
    });

    it('consume happy path', async () => {
      const store = makeStore();
      const record = baseRecord();
      await store.create(record);
      const consumed = await store.consume({
        applicationId: 'app-1',
        stateHash: 'state-1',
        browserBindingHash: 'bind-1',
        providerId: 'cognito',
        now: new Date('2026-01-01T00:30:00.000Z'),
      });
      expect(consumed).toEqual(record);
    });

    it('double consume returns null', async () => {
      const store = makeStore();
      await store.create(baseRecord());
      const query = {
        applicationId: 'app-1',
        stateHash: 'state-1',
        browserBindingHash: 'bind-1',
        providerId: 'cognito',
        now: new Date('2026-01-01T00:30:00.000Z'),
      };
      await expect(store.consume(query)).resolves.toEqual(baseRecord());
      await expect(store.consume(query)).resolves.toBeNull();
    });

    it('consume rejects wrong provider/binding/expired', async () => {
      const store = makeStore();
      await store.create(baseRecord());
      await expect(
        store.consume({
          applicationId: 'app-1',
          stateHash: 'state-1',
          browserBindingHash: 'wrong',
          providerId: 'cognito',
          now: new Date('2026-01-01T00:30:00.000Z'),
        }),
      ).resolves.toBeNull();
      await expect(
        store.consume({
          applicationId: 'app-1',
          stateHash: 'state-1',
          browserBindingHash: 'bind-1',
          providerId: 'other',
          now: new Date('2026-01-01T00:30:00.000Z'),
        }),
      ).resolves.toBeNull();
      await expect(
        store.consume({
          applicationId: 'app-1',
          stateHash: 'state-1',
          browserBindingHash: 'bind-1',
          providerId: 'cognito',
          now: new Date('2026-01-01T02:00:00.000Z'),
        }),
      ).resolves.toBeNull();
    });
  });
}
