import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryIdempotencyStore,
  DEFAULT_IN_MEMORY_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS,
  hashPayload,
  IdempotencyAbortedError,
  isAnonymousIdempotencyPrincipal,
  parseIdempotencyTtl,
  type IdempotencyPrincipal,
} from '../idempotency.js';

describe('isAnonymousIdempotencyPrincipal', () => {
  it('is true when userId and tenantId are both absent', () => {
    expect(isAnonymousIdempotencyPrincipal({})).toBe(true);
  });

  it('is false when userId or tenantId is set', () => {
    expect(isAnonymousIdempotencyPrincipal({ userId: 'u1' })).toBe(false);
    expect(isAnonymousIdempotencyPrincipal({ tenantId: 't1' })).toBe(false);
    expect(isAnonymousIdempotencyPrincipal({ userId: 'u1', tenantId: 't1' })).toBe(false);
  });
});

describe('hashPayload', () => {
  it('produces stable hashes regardless of key order', () => {
    const a = hashPayload({ b: 2, a: 1 });
    const b = hashPayload({ a: 1, b: 2 });
    expect(a).toBe(b);
  });
});

describe('createInMemoryIdempotencyStore', () => {
  const principal: IdempotencyPrincipal = { userId: 'u1', tenantId: 't1' };

  it('claim new then complete allows replay', async () => {
    const store = createInMemoryIdempotencyStore();
    const claim = await store.claim('k', 'hash', principal);
    expect(claim.status).toBe('new');
    await store.complete('k', { ok: true });
    const replay = await store.claim('k', 'hash', principal);
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay') {
      expect(replay.record.result).toEqual({ ok: true });
    }
  });

  it('concurrent claims with same key yield one new and one in-flight', async () => {
    const store = createInMemoryIdempotencyStore();
    const [first, second] = await Promise.all([
      store.claim('k', 'hash', principal),
      store.claim('k', 'hash', principal),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['in-flight', 'new']);
  });

  it('in-flight waiter receives completed result', async () => {
    const store = createInMemoryIdempotencyStore();
    const [first, second] = await Promise.all([
      store.claim('k', 'hash', principal),
      store.claim('k', 'hash', principal),
    ]);
    expect(first.status === 'new' || second.status === 'new').toBe(true);
    const waiter = first.status === 'in-flight' ? first : second;
    expect(waiter.status).toBe('in-flight');
    if (waiter.status !== 'in-flight') {
      return;
    }
    const completePromise = store.complete('k', { value: 42 });
    const record = await waiter.wait;
    await completePromise;
    expect(record.result).toEqual({ value: 42 });
  });

  it('abort releases key for a subsequent claim', async () => {
    const store = createInMemoryIdempotencyStore();
    await store.claim('k', 'hash', principal);
    await store.abort('k');
    const again = await store.claim('k', 'hash', principal);
    expect(again.status).toBe('new');
  });

  it('detects payload conflict on replay', async () => {
    const store = createInMemoryIdempotencyStore();
    await store.claim('k', 'hash-a', principal);
    await store.complete('k', { ok: true });
    const conflict = await store.claim('k', 'hash-b', principal);
    expect(conflict.status).toBe('conflict');
    if (conflict.status === 'conflict') {
      expect(conflict.reason).toBe('payload');
    }
  });

  it('abort rejects in-flight waiters so a fresh claim can proceed', async () => {
    const store = createInMemoryIdempotencyStore();
    const claimA = await store.claim('k', 'hash', principal);
    expect(claimA.status).toBe('new');

    const claimB = await store.claim('k', 'hash', principal);
    expect(claimB.status).toBe('in-flight');
    if (claimB.status !== 'in-flight') {
      return;
    }

    const waitRejected = expect(claimB.wait).rejects.toBeInstanceOf(IdempotencyAbortedError);
    await store.abort('k');
    await waitRejected;

    const claimC = await store.claim('k', 'hash', principal);
    expect(claimC.status).toBe('new');
  });

  it('expires completed records when ttlMs is configured', async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryIdempotencyStore();
      await store.claim('k', 'hash', principal, { ttlMs: 1_000 });
      await store.complete('k', { ok: true }, { ttlMs: 1_000 });

      const replay = await store.claim('k', 'hash', principal, { ttlMs: 1_000 });
      expect(replay.status).toBe('replay');

      vi.advanceTimersByTime(1_001);

      const fresh = await store.claim('k', 'hash', principal, { ttlMs: 1_000 });
      expect(fresh.status).toBe('new');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseIdempotencyTtl', () => {
  it('parses supported duration strings', () => {
    expect(parseIdempotencyTtl('30s')).toBe(30_000);
    expect(parseIdempotencyTtl('5m')).toBe(300_000);
    expect(parseIdempotencyTtl('24h')).toBe(86_400_000);
    expect(parseIdempotencyTtl('7d')).toBe(604_800_000);
  });

  it('returns undefined for invalid strings', () => {
    expect(parseIdempotencyTtl('')).toBeUndefined();
    expect(parseIdempotencyTtl('24hours')).toBeUndefined();
  });
});

describe('createInMemoryIdempotencyStore — bounds', () => {
  const principal: IdempotencyPrincipal = { userId: 'u1', tenantId: 't1' };

  it('applies a 24h default TTL when the route gives none', async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryIdempotencyStore();
      await store.claim('k', 'hash', principal);
      await store.complete('k', { ok: true });
      vi.advanceTimersByTime(DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS - 1);
      expect((await store.claim('k', 'hash', principal)).status).toBe('replay');
      vi.advanceTimersByTime(2);
      expect((await store.claim('k', 'hash', principal)).status).toBe('new');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaultTtlMs is overridable and the route ttlMs wins over it', async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryIdempotencyStore({ defaultTtlMs: 1_000 });
      await store.claim('a', 'hash', principal);
      await store.complete('a', { ok: true });
      await store.claim('b', 'hash', principal);
      await store.complete('b', { ok: true }, { ttlMs: 5_000 });
      vi.advanceTimersByTime(1_001);
      expect((await store.claim('a', 'hash', principal)).status).toBe('new');
      expect((await store.claim('b', 'hash', principal)).status).toBe('replay');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaultTtlMs: Infinity keeps records without expiry', async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryIdempotencyStore({ defaultTtlMs: Number.POSITIVE_INFINITY });
      await store.claim('k', 'hash', principal);
      await store.complete('k', { ok: true });
      vi.advanceTimersByTime(365 * DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS);
      expect((await store.claim('k', 'hash', principal)).status).toBe('replay');
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest completed records beyond maxEntries', async () => {
    const store = createInMemoryIdempotencyStore({ maxEntries: 2 });
    for (const key of ['k1', 'k2', 'k3']) {
      await store.claim(key, 'hash', principal);
      await store.complete(key, { key });
    }
    expect((await store.claim('k1', 'hash', principal)).status).toBe('new');
    // Claiming k1 again pushed the store over the bound and evicted k2 (oldest completed).
    expect((await store.claim('k2', 'hash', principal)).status).toBe('new');
  });

  it('keeps the newest completed records when evicting', async () => {
    const store = createInMemoryIdempotencyStore({ maxEntries: 2 });
    for (const key of ['k1', 'k2', 'k3']) {
      await store.claim(key, 'hash', principal);
      await store.complete(key, { key });
    }
    expect((await store.claim('k3', 'hash', principal)).status).toBe('replay');
    expect((await store.claim('k2', 'hash', principal)).status).toBe('replay');
  });

  it('never evicts in-flight claims', async () => {
    const store = createInMemoryIdempotencyStore({ maxEntries: 1 });
    await store.claim('a', 'hash', principal);
    await store.claim('b', 'hash', principal);
    const waiting = await store.claim('a', 'hash', principal);
    expect(waiting.status).toBe('in-flight');
    await store.complete('a', { done: true });
    if (waiting.status === 'in-flight') {
      await expect(waiting.wait).resolves.toMatchObject({ result: { done: true } });
    }
  });

  it('uses a 10 000-entry default bound', () => {
    expect(DEFAULT_IN_MEMORY_IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
  });
});
