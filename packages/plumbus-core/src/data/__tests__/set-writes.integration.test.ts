// Set-based repository writes and narrower reads against a real PostgreSQL (a private,
// disposable cluster): deleteMany / updateMany with their audit modes, `in` lists past the
// 65,535-parameter limit, the json `contains` filter served by a GIN index, and `update`
// without reading the row back.

import { drizzle } from 'drizzle-orm/postgres-js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from '../../audit/service.js';
import { defineEntity } from '../../define/defineEntity.js';
import { DataInternalError, DataValidationError } from '../../errors/index.js';
import { field } from '../../fields/index.js';
import { startPostgres } from '../../flows/__tests__/postgres-fixture.js';
import { createInMemoryRepository } from '../../testing/index.js';
import type { FrameworkRepository, Repository } from '../../types/context.js';
import { isEncryptedValue } from '../field-encryption.js';
import { createRepository } from '../repository.js';
import { generateDrizzleSchema } from '../schema-generator.js';

const entity = defineEntity({
  name: 'SweepItem',
  tenantScoped: true,
  fields: {
    id: field.id(),
    day: field.timestamp({ required: true }),
    state: field.string({ required: true }),
    owner: field.string({ required: true, maskedInLogs: true }),
    secret: field.string({ encrypted: true }),
    seenAt: field.timestamp({ auditSilent: true }),
    assetIds: field.json(),
    payload: field.json(),
  },
  indexes: [{ columns: ['assetIds'], using: 'gin' }],
});
const softEntity = defineEntity({
  name: 'SoftItem',
  tenantScoped: true,
  fields: { id: field.id(), state: field.string({ required: true }), deletedAt: field.timestamp() },
});
const table = generateDrizzleSchema(entity);
const softTable = generateDrizzleSchema(softEntity);
type Item = {
  id: string;
  day: Date;
  state: string;
  owner: string;
  secret?: string | null;
  seenAt?: Date | null;
  assetIds?: unknown;
  payload?: unknown;
  updatedAt?: Date;
};
const auth = { userId: 'u', tenantId: 'one', roles: ['user'], scopes: [], provider: 'test' };
const key = Buffer.alloc(32, 7);

let pg: Awaited<ReturnType<typeof startPostgres>>;
const queries: Array<{ query: string; params: unknown[] }> = [];
const db = () =>
  drizzle(pg.sql, { logger: { logQuery: (query, params) => queries.push({ query, params }) } });

function repo(withAudit = true): FrameworkRepository<Item> {
  const d = db();
  return createRepository<Item>({
    entity,
    table,
    db: d,
    auth,
    encryptionKey: key,
    ...(withAudit ? { audit: createAuditService({ db: d, auth, component: 'test' }) } : {}),
  });
}

async function auditRows(action: string) {
  return (await pg.sql`
    SELECT action, outcome, metadata FROM audit_records WHERE action = ${action} ORDER BY timestamp
  `) as unknown as Array<{ action: string; outcome: string; metadata: Record<string, any> }>;
}

async function seed(count: number, tenant = 'one', state = 'open', day = '2026-01-01') {
  await pg.sql.unsafe(`
    INSERT INTO sweep_item (id, tenant_id, day, state, owner, asset_ids)
    SELECT gen_random_uuid(), '${tenant}', '${day}T00:00:00Z'::timestamptz + (g || ' minutes')::interval,
           '${state}', 'owner-' || g, jsonb_build_array('asset-' || (g % 10))
    FROM generate_series(1, ${count}) g
  `);
}

beforeAll(async () => {
  pg = await startPostgres();
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ table, softTable }),
  )) {
    await pg.sql.unsafe(statement);
  }
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.sql.unsafe('TRUNCATE sweep_item, soft_item, audit_records');
  queries.length = 0;
});

describe('deleteMany', () => {
  it('deletes at most `limit` matching rows of the tenant in one statement, and drains in batches', async () => {
    await seed(25);
    await seed(5, 'two');
    const r = repo();
    const cutoff = new Date('2026-01-01T00:20:00Z');
    queries.length = 0;
    const first = await r.deleteMany(undefined, {
      dateFilters: { day: { lte: cutoff } },
      limit: 8,
    });
    expect(first.count).toBe(8);
    expect(first.ids).toHaveLength(8);
    const deletes = queries.filter((q) => /^delete/i.test(q.query));
    expect(deletes).toHaveLength(1);
    // The filters are applied to the bounded id subquery and again to the outer statement.
    expect(deletes[0]?.query).toMatch(/where \("sweep_item"\."id" in \(select/i);
    expect(deletes[0]?.query.match(/"sweep_item"\."day" <= \$/g)?.length).toBe(2);

    let total = first.count;
    for (;;) {
      const next = await r.deleteMany(undefined, {
        dateFilters: { day: { lte: cutoff } },
        limit: 8,
      });
      total += next.count;
      if (next.count < 8) break;
    }
    expect(total).toBe(20);
    expect(await r.count()).toBe(5);
    const [{ n }] =
      (await pg.sql`SELECT count(*)::int AS n FROM sweep_item WHERE tenant_id = 'two'`) as any;
    expect(n).toBe(5);
  });

  it('per-row audit (default): the same rows a loop of delete(id) writes, inserted in one statement', async () => {
    await seed(30);
    const r = repo();
    queries.length = 0;
    const result = await r.deleteMany({ state: 'open' } as Partial<Item>, { limit: 1000 });
    expect(result.count).toBe(30);
    const rows = await auditRows('SweepItem.delete');
    expect(rows).toHaveLength(30);
    expect(rows.map((row) => row.metadata.id).sort()).toEqual([...result.ids].sort());
    expect(rows[0]?.outcome).toBe('success');
    expect(queries.filter((q) => /^insert into "audit_records"/i.test(q.query))).toHaveLength(1);

    // The same shape as the single-row delete.
    await seed(1);
    const [one] = await r.findMany({}, { limit: 1 });
    await r.delete(String(one?.id));
    const single = (await auditRows('SweepItem.delete')).at(-1);
    expect(Object.keys(single?.metadata ?? {}).sort()).toEqual(
      Object.keys(rows[0]?.metadata ?? {}).sort(),
    );
  });

  it("audit: 'summary' writes one row with the count and the masked filter, and no ids", async () => {
    await seed(12);
    const r = repo();
    const ids = (await r.findMany({}, { limit: 3 })).map((row) => row.id);
    const result = await r.deleteMany({ owner: 'owner-1' } as Partial<Item>, {
      limit: 50,
      audit: 'summary',
      notEq: { owner: 'x' },
      in: { id: ids, owner: ['owner-1', 'owner-2'] },
    });
    expect(result.count).toBe(1);
    expect(await auditRows('SweepItem.delete')).toEqual([]);
    const [summary] = await auditRows('SweepItem.deleteMany');
    expect(summary?.metadata).toMatchObject({
      count: 1,
      limit: 50,
      filter: {
        where: { owner: '***' },
        notEq: { owner: '***' },
        in: { id: ids, owner: ['***', '***'] },
      },
    });
    expect(JSON.stringify(summary?.metadata)).not.toContain('owner-1');
    expect(summary?.metadata).not.toHaveProperty('ids');
  });

  it('writes no audit row when nothing matched, and refuses a missing or invalid limit', async () => {
    await seed(3);
    const r = repo();
    expect(await r.deleteMany({ state: 'none' } as Partial<Item>, { limit: 10 })).toEqual({
      count: 0,
      ids: [],
    });
    expect(await auditRows('SweepItem.delete')).toEqual([]);
    await expect(r.deleteMany(undefined, {} as any)).rejects.toBeInstanceOf(DataValidationError);
    await expect(r.deleteMany(undefined, { limit: 0 })).rejects.toBeInstanceOf(DataValidationError);
    await expect(
      r.deleteMany(undefined, { limit: 5, audit: 'none' as any }),
    ).rejects.toBeInstanceOf(DataValidationError);
    expect(await r.count()).toBe(3);
  });

  it('a soft-deleting repository sets deletedAt and skips rows already deleted', async () => {
    await pg.sql.unsafe(`
      INSERT INTO soft_item (id, tenant_id, state) SELECT gen_random_uuid(), 'one', 'old' FROM generate_series(1, 4);
    `);
    const soft = createRepository<{ id: string; state: string }>({
      entity: softEntity,
      table: softTable,
      db: db(),
      auth,
      softDelete: true,
    });
    expect((await soft.deleteMany({ state: 'old' }, { limit: 3 })).count).toBe(3);
    expect((await soft.deleteMany({ state: 'old' }, { limit: 3 })).count).toBe(1);
    expect((await soft.deleteMany({ state: 'old' }, { limit: 3 })).count).toBe(0);
    const [{ n }] =
      (await pg.sql`SELECT count(*)::int AS n FROM soft_item WHERE deleted_at IS NOT NULL`) as any;
    expect(n).toBe(4);
  });

  it('orderBy chooses which rows a bounded call takes', async () => {
    await seed(10);
    const r = repo(false);
    const newest = await r.findMany({}, { orderBy: 'day', orderDir: 'desc', limit: 2 });
    const result = await r.deleteMany(undefined, { limit: 2, orderBy: 'day', orderDir: 'desc' });
    expect([...result.ids].sort()).toEqual(newest.map((row) => row.id).sort());
  });
});

describe('updateMany', () => {
  it('applies the values to at most `limit` rows, sets updatedAt, encrypts, and audits per row with masking', async () => {
    await seed(6);
    const r = repo();
    const before = new Date();
    const result = await r.updateMany(
      { state: 'open' } as Partial<Item>,
      { state: 'closed', owner: 'someone', secret: 'hidden' } as Partial<Item>,
      { limit: 4 },
    );
    expect(result.count).toBe(4);
    const raw =
      (await pg.sql`SELECT state, secret, updated_at FROM sweep_item WHERE state = 'closed'`) as any[];
    expect(raw).toHaveLength(4);
    expect(raw.every((row) => isEncryptedValue(row.secret))).toBe(true);
    expect(raw.every((row) => new Date(row.updated_at) >= new Date(before.getTime() - 1000))).toBe(
      true,
    );
    const rows = await auditRows('SweepItem.update');
    expect(rows).toHaveLength(4);
    expect(rows[0]?.metadata).toMatchObject({ state: 'closed', owner: '***' });
    // Excluding the rows already changed, the next call takes the rest.
    expect(
      (await r.updateMany({ state: 'open' } as Partial<Item>, { state: 'closed' }, { limit: 4 }))
        .count,
    ).toBe(2);
  });

  it("audit: 'summary' writes one row; an auditSilent-only change writes none", async () => {
    await seed(5);
    const r = repo();
    await r.updateMany(undefined, { state: 'done' }, { limit: 10, audit: 'summary' });
    const [summary] = await auditRows('SweepItem.updateMany');
    expect(summary?.metadata).toMatchObject({ count: 5, limit: 10, values: { state: 'done' } });
    await r.updateMany(undefined, { seenAt: new Date() } as Partial<Item>, { limit: 10 });
    expect(await auditRows('SweepItem.update')).toEqual([]);
    expect(await auditRows('SweepItem.updateMany')).toHaveLength(1);
  });

  it('refuses id, tenantId, unknown fields and an empty change', async () => {
    const r = repo();
    for (const values of [{ id: 'x' }, { tenantId: 'two' }, { nope: 1 }, {}]) {
      await expect(r.updateMany(undefined, values as any, { limit: 1 })).rejects.toBeInstanceOf(
        DataValidationError,
      );
    }
  });
});

describe('in lists', () => {
  it('a list past 65,535 values is one array parameter, and matches exactly', async () => {
    await seed(40);
    const r = repo(false);
    const real = (await r.findMany({}, { limit: 40 })).map((row) => row.id);
    const filler = Array.from({ length: 70_000 }, () => crypto.randomUUID());
    queries.length = 0;
    const found = await r.findMany({}, { in: { id: [...filler, ...real.slice(0, 7)] } });
    expect(found).toHaveLength(7);
    expect(queries.at(-1)?.query).toMatch(/"sweep_item"\."id" = any\(\$\d+::uuid\[\]\)/i);
    expect(queries.at(-1)?.params.length).toBeLessThan(5);
    expect(await r.count({}, { in: { id: [...filler, ...real] } })).toBe(40);
    expect(
      (await r.deleteMany(undefined, { in: { id: [...filler, ...real.slice(0, 3)] }, limit: 100 }))
        .count,
    ).toBe(3);
    // Text columns too, and the empty list still matches nothing.
    expect(await r.count({}, { in: { state: ['open', 'x'] } })).toBe(37);
    expect(await r.count({}, { in: { state: [] } })).toBe(0);
  });
});

describe('contains (json)', () => {
  it('matches rows whose json column contains the value, on every read and write', async () => {
    await seed(20);
    await pg.sql.unsafe(
      `UPDATE sweep_item SET payload = '{"kind":"draft","tags":["a","b"]}'::jsonb WHERE owner = 'owner-3'`,
    );
    const r = repo(false);
    expect(await r.count({}, { contains: { assetIds: ['asset-3'] } })).toBe(2);
    expect(await r.exists({}, { contains: { assetIds: ['asset-3'] } })).toBe(true);
    expect(await r.findMany({}, { contains: { payload: { kind: 'draft' } } })).toHaveLength(1);
    expect(
      await r.count({}, { contains: { payload: { tags: ['b'] }, assetIds: ['asset-3'] } }),
    ).toBe(1);
    expect(
      (await r.findPage(undefined, { limit: 5, contains: { assetIds: ['asset-4'] } })).rows,
    ).toHaveLength(2);
    expect(await r.aggregate({}, { contains: { assetIds: ['asset-5'] }, count: true })).toEqual([
      { count: 2 },
    ]);
    expect(
      (await r.deleteMany(undefined, { contains: { assetIds: ['asset-5'] }, limit: 10 })).count,
    ).toBe(2);
  });

  it('is served by the declared GIN jsonb_path_ops index', async () => {
    await seed(2000);
    await pg.sql.unsafe('ANALYZE sweep_item');
    const r = repo(false);
    queries.length = 0;
    await r.count({}, { contains: { assetIds: ['asset-1'] } });
    const last = queries.at(-1);
    expect(last?.query).toMatch(/"sweep_item"\."asset_ids" @> \$\d+::jsonb/);
    const indexes = (await pg.sql`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'sweep_item' AND indexdef ILIKE '%gin%'
    `) as any[];
    expect(indexes[0]?.indexdef).toMatch(/USING gin \(asset_ids jsonb_path_ops\)/);
    const plan = await pg.sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      return tx.unsafe(`EXPLAIN ${last?.query}`, last?.params as any[]);
    });
    expect(plan.map((row: any) => row['QUERY PLAN']).join('\n')).toMatch(
      /sweep_item_asset_ids_idx_gin/,
    );
  });

  it('refuses a field that is not json', async () => {
    await expect(repo(false).count({}, { contains: { state: 'x' } })).rejects.toBeInstanceOf(
      DataValidationError,
    );
  });
});

describe('update { returning: false }', () => {
  it('reads back only the id, resolves undefined, and still refuses a missing row', async () => {
    await seed(1);
    const r = repo();
    const [row] = await r.findMany({}, { limit: 1 });
    queries.length = 0;
    const result = await r.update(String(row?.id), { state: 'quiet' }, { returning: false });
    expect(result).toBeUndefined();
    const update = queries.find((q) => /^update/i.test(q.query));
    expect(update?.query).toMatch(/returning "id"$/i);
    expect(update?.query).not.toMatch(/"payload"/);
    expect((await r.findById(String(row?.id)))?.state).toBe('quiet');
    expect(await auditRows('SweepItem.update')).toHaveLength(1);
    await expect(
      r.update(crypto.randomUUID(), { state: 'x' }, { returning: false }),
    ).rejects.toBeInstanceOf(DataInternalError);
    // Default unchanged: the whole row.
    expect(await r.update(String(row?.id), { state: 'loud' })).toMatchObject({
      id: row?.id,
      state: 'loud',
      owner: 'owner-1',
    });
  });
});

describe('in-memory repository follows', () => {
  it('deleteMany, updateMany, contains and returning: false', async () => {
    const mem: Repository<Record<string, unknown>> = createInMemoryRepository([
      { id: 'a', state: 'open', tags: ['x', 'y'], meta: { kind: 'draft', n: 1 } },
      { id: 'b', state: 'open', tags: ['y'] },
      { id: 'c', state: 'done', tags: [] },
    ]);
    expect(await mem.count({}, { contains: { tags: ['y'] } })).toBe(2);
    expect(await mem.count({}, { contains: { meta: { kind: 'draft' } } })).toBe(1);
    expect(await mem.updateMany?.({ state: 'open' }, { state: 'closed' }, { limit: 1 })).toEqual({
      count: 1,
      ids: ['a'],
    });
    expect(await mem.update('b', { state: 'closed' }, { returning: false })).toBeUndefined();
    expect(await mem.deleteMany?.({ state: 'closed' }, { limit: 5 })).toEqual({
      count: 2,
      ids: ['a', 'b'],
    });
    await expect(mem.deleteMany?.(undefined, { limit: 0 })).rejects.toThrow(/limit/);
    expect(await mem.count()).toBe(1);
  });
});
