// Repository reads against a real PostgreSQL (a private, disposable cluster): the read
// ceiling, exact limits, an empty IN list, exists(), and keyset paging with findPage().

import { drizzle } from 'drizzle-orm/postgres-js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineEntity } from '../../define/defineEntity.js';
import { DataReadCeilingError, DataValidationError } from '../../errors/index.js';
import { field } from '../../fields/index.js';
import { startPostgres } from '../../flows/__tests__/postgres-fixture.js';
import { createInMemoryRepository } from '../../testing/index.js';
import type { Repository } from '../../types/context.js';
import { createReadCeilingPolicy, type ReadCeilingPolicy } from '../read-ceiling.js';
import { createRepository } from '../repository.js';
import { generateDrizzleSchema } from '../schema-generator.js';

const entity = defineEntity({
  name: 'CeilingItem',
  tenantScoped: true,
  fields: {
    id: field.id(),
    rank: field.number({ required: true }),
    title: field.string({ required: true }),
  },
});
const table = generateDrizzleSchema(entity);
type Item = { id: string; rank: number; title: string; tenantId?: string };
const auth = { userId: 'u', tenantId: 'one', roles: ['user'], scopes: [], provider: 'test' };
const ROWS = 1001;

let pg: Awaited<ReturnType<typeof startPostgres>>;
const queries: string[] = [];

function repo(policy?: ReadCeilingPolicy): Repository<Item> {
  const db = drizzle(pg.sql, { logger: { logQuery: (query) => queries.push(query) } });
  return createRepository<Item>({
    entity,
    table,
    db,
    auth,
    ...(policy ? { readCeiling: policy } : {}),
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ table }),
  )) {
    await pg.sql.unsafe(statement);
  }
  // 1001 rows of tenant "one" (ranks 0..9, so many ties) and 5 of another tenant.
  await pg.sql.unsafe(`
    INSERT INTO ceiling_item (id, tenant_id, rank, title)
    SELECT gen_random_uuid(), 'one', g % 10, 'item ' || g FROM generate_series(1, ${ROWS}) g;
    INSERT INTO ceiling_item (id, tenant_id, rank, title)
    SELECT gen_random_uuid(), 'two', 1, 'other ' || g FROM generate_series(1, 5) g;
  `);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(() => {
  queries.length = 0;
});

describe('read ceiling on PostgreSQL', () => {
  it('warn (default): an unlimited read past 1000 rows still returns every row, and is reported', async () => {
    const report = vi.fn();
    const rows = await repo(createReadCeilingPolicy({ report })).findMany();
    expect(rows).toHaveLength(ROWS);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'CeilingItem', rows: ROWS, ceiling: 1000 }),
    );
    expect(queries.at(-1)).not.toMatch(/\blimit\b/i);
  });

  it('error: the same read is bounded in SQL and refused', async () => {
    const strict = repo(createReadCeilingPolicy({ mode: 'error' }));
    await expect(strict.findMany()).rejects.toBeInstanceOf(DataReadCeilingError);
    expect(queries.at(-1)).toMatch(/\blimit \$\d+/i);
    // Narrowed under the ceiling it answers in full.
    expect(await strict.findMany({ rank: 3 } as Partial<Item>)).toHaveLength(100);
  });

  it('error: { unbounded: true } reads every row', async () => {
    const strict = repo(createReadCeilingPolicy({ mode: 'error' }));
    expect(await strict.findMany({}, { unbounded: true })).toHaveLength(ROWS);
  });

  it('warn: a limit above the ceiling is honoured exactly in SQL and reported', async () => {
    const report = vi.fn();
    const r = repo(createReadCeilingPolicy({ maxRows: 100, report }));
    expect(await r.findMany({}, { limit: 500 })).toHaveLength(500);
    expect(queries.at(-1)).toMatch(/\blimit \$\d+/i);
    const page = await r.findPage?.(undefined, { limit: 250 });
    expect(page?.rows).toHaveLength(250);
    expect(page?.nextCursor).toBeTruthy();
    const groups = await r.aggregate({}, { groupBy: 'title', count: true, limit: 300 });
    expect(groups).toHaveLength(300);
    expect(report.mock.calls.map(([event]) => [event.operation, event.cause, event.limit])).toEqual(
      [
        ['findMany', 'limit-over-ceiling', 500],
        ['findPage', 'limit-over-ceiling', 250],
        ['aggregate', 'limit-over-ceiling', 300],
      ],
    );
  });

  it('error: a limit above the ceiling is refused before any query', async () => {
    const strict = repo(createReadCeilingPolicy({ maxRows: 100, mode: 'error' }));
    await expect(strict.findMany({}, { limit: 500 })).rejects.toBeInstanceOf(DataReadCeilingError);
    expect(queries).toEqual([]);
  });

  it('honours limit: 500 exactly (earlier releases returned 100)', async () => {
    expect(await repo().findMany({}, { limit: 500 })).toHaveLength(500);
    expect(await repo().findMany({}, { limit: 0 })).toEqual([]);
  });

  it('an empty IN list matches nothing: findMany, count, exists, aggregate', async () => {
    const r = repo();
    expect(await r.findMany({}, { in: { id: [] } })).toEqual([]);
    expect(await r.count({}, { in: { id: [] } })).toBe(0);
    expect(await r.exists?.({}, { in: { id: [] } })).toBe(false);
    expect(await r.aggregate({}, { in: { id: [] }, count: true })).toEqual([{ count: 0 }]);
  });

  it('exists answers without loading rows, inside the tenant', async () => {
    const r = repo();
    expect(await r.exists?.({ rank: 9 } as Partial<Item>)).toBe(true);
    expect(await r.exists?.({ title: 'other 1' } as Partial<Item>)).toBe(false);
    expect(queries.at(-1)).toMatch(/select 1 from "ceiling_item".*limit \$\d+/i);
  });
});

describe('findPage (keyset) on PostgreSQL', () => {
  async function walk(r: Repository<Item>, pageSize: number) {
    const seen: Item[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await r.findPage?.(undefined, {
        limit: pageSize,
        orderBy: [{ column: 'rank', dir: 'desc' }],
        ...(after ? { after } : {}),
      });
      if (!page) throw new Error('findPage missing');
      seen.push(...page.rows);
      pages += 1;
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    return { seen, pages };
  }

  it('walks every row exactly once in (rank desc, id desc) order, ties included', async () => {
    const { seen, pages } = await walk(repo(), 97);
    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen.map((row) => row.id)).size).toBe(ROWS);
    expect(pages).toBe(Math.ceil(ROWS / 97));
    const expected = [...seen].sort((a, b) =>
      a.rank !== b.rank ? b.rank - a.rank : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
    expect(seen.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(seen.every((row) => row.tenantId === 'one')).toBe(true);
    // A page is keyset, not OFFSET.
    expect(queries.some((query) => /\boffset\b/i.test(query))).toBe(false);
  });

  it('the in-memory test repository pages the same rows in the same order', async () => {
    const all = await repo().findMany({}, { unbounded: true });
    const memory = createInMemoryRepository<Item>(all.map((row) => ({ ...row })));
    const fromPg = (await walk(repo(), 50)).seen.map((row) => row.id);
    const fromMemory = (await walk(memory, 50)).seen.map((row) => row.id);
    expect(fromMemory).toEqual(fromPg);
  });

  it('refuses a cursor of another sort and a missing limit', async () => {
    const r = repo();
    const first = await r.findPage?.(undefined, { limit: 10 });
    expect(first?.nextCursor).toBeTruthy();
    await expect(
      r.findPage?.(undefined, { limit: 10, orderBy: 'title', after: first?.nextCursor ?? '' }),
    ).rejects.toBeInstanceOf(DataValidationError);
    await expect(r.findPage?.(undefined, { limit: 0 })).rejects.toBeInstanceOf(DataValidationError);
    await expect(r.findPage?.(undefined, { limit: 5, orderBy: 'nope' })).rejects.toBeInstanceOf(
      DataValidationError,
    );
  });
});
