// The admission lock on a real PostgreSQL (a private, disposable cluster): shared holders run
// together and exclude exclusive holders of the same key, and a lock timeout refuses with a
// typed error while leaving the caller's own lock_timeout as it was.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres } from '../../flows/__tests__/postgres-fixture.js';
import {
  RequestAdmissionLockTimeoutError,
  withRequestAdmissionLock,
} from '../request-admission.js';

let pg: Awaited<ReturnType<typeof startPostgres>>;

beforeAll(async () => {
  pg = await startPostgres();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe('withRequestAdmissionLock', () => {
  it("mode: 'shared' holders of one key run together; an exclusive holder waits for them", async () => {
    const a = pg.connect();
    const b = pg.connect();
    const c = pg.connect();
    const release = gate();
    let inside = 0;
    let most = 0;
    const shared = (db: typeof a.db) =>
      withRequestAdmissionLock(
        db,
        'scope:1',
        async () => {
          inside += 1;
          most = Math.max(most, inside);
          await release.wait;
          inside -= 1;
        },
        { mode: 'shared' },
      );
    const first = shared(a.db);
    const second = shared(b.db);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(most).toBe(2);

    let exclusiveRan = false;
    const exclusive = withRequestAdmissionLock(c.db, 'scope:1', async () => {
      exclusiveRan = true;
      expect(inside).toBe(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exclusiveRan).toBe(false);
    release.open();
    await Promise.all([first, second, exclusive]);
    expect(exclusiveRan).toBe(true);
  }, 30_000);

  it('lockTimeoutMs refuses with RequestAdmissionLockTimeoutError, and restores lock_timeout when granted', async () => {
    const a = pg.connect();
    const b = pg.connect();
    const release = gate();
    const held = withRequestAdmissionLock(a.db, 'cutover', () => release.wait);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refused = await withRequestAdmissionLock(b.db, 'cutover', async () => 'ran', {
      mode: 'shared',
      lockTimeoutMs: 150,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RequestAdmissionLockTimeoutError);
    expect((refused as RequestAdmissionLockTimeoutError).metadata).toMatchObject({
      reason: 'admission-lock-timeout',
      httpStatus: 503,
      mode: 'shared',
    });
    release.open();
    await held;

    const timeoutInside = await b.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '7s'`);
      return withRequestAdmissionLock(
        tx,
        'cutover',
        async (inner) => {
          const [row] = (await inner.execute(
            sql`SELECT current_setting('lock_timeout') AS value`,
          )) as unknown as Array<{ value: string }>;
          return row?.value;
        },
        { lockTimeoutMs: 500 },
      );
    });
    expect(timeoutInside).toBe('7s');
  }, 30_000);

  it('refuses an unknown mode or a bad timeout before touching the database', async () => {
    await expect(
      withRequestAdmissionLock(pg.db, 'k', async () => 1, { mode: 'other' as never }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      withRequestAdmissionLock(pg.db, 'k', async () => 1, { lockTimeoutMs: 0 }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
