import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { DataReadCeilingError, DataValidationError } from '../../errors/index.js';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  createReadCeilingPolicy,
  decodeKeysetCursor,
  encodeKeysetCursor,
  planReadBound,
  type ReadCeilingEvent,
  readCeilingPolicyFromConfig,
  resolveKeysetKeys,
} from '../read-ceiling.js';
import { EntityRegistry } from '../registry.js';
import { createRepository } from '../repository.js';
import { generateDrizzleSchema } from '../schema-generator.js';

const entity: EntityDefinition = {
  name: 'Document',
  fields: { id: field.id(), title: field.string({ required: true }) },
} as EntityDefinition;
const table = generateDrizzleSchema(entity);
const auth = { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test' };

/** A Drizzle stand-in that records the query shape and answers `rows`. */
function queryDb(rows: unknown[]) {
  const calls: { limit?: number; where?: unknown } = {};
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn((where: unknown) => {
      calls.where = where;
      return chain;
    }),
    orderBy: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    limit: vi.fn((limit: number) => {
      calls.limit = limit;
      return chain;
    }),
    offset: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown) =>
      resolve(calls.limit === undefined ? rows : rows.slice(0, calls.limit)),
  };
  return { db: { select: vi.fn(() => chain) }, calls };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `t${i}` }));

function repoWith(n: number, policy = createReadCeilingPolicy({ maxRows: 3 })) {
  const { db, calls } = queryDb(rows(n));
  return {
    repo: createRepository({ entity, table, db: db as never, auth, readCeiling: policy }),
    calls,
  };
}

describe('planReadBound', () => {
  const warn = () => createReadCeilingPolicy({ maxRows: 10, mode: 'warn', report: vi.fn() });
  const error = () => createReadCeilingPolicy({ maxRows: 10, mode: 'error' });

  it('honours a limit at or under the ceiling exactly, in both modes', () => {
    expect(planReadBound(warn(), 'E', 'findMany', { limit: 10 }).sqlLimit).toBe(10);
    expect(planReadBound(error(), 'E', 'findMany', { limit: 0 }).sqlLimit).toBe(0);
  });

  it('refuses a negative or fractional limit', () => {
    expect(() => planReadBound(warn(), 'E', 'findMany', { limit: -1 })).toThrow(
      DataValidationError,
    );
    expect(() => planReadBound(warn(), 'E', 'findMany', { limit: 2.5 })).toThrow(
      DataValidationError,
    );
  });

  it('error mode: refuses a limit over the ceiling before any query', () => {
    expect(() => planReadBound(error(), 'E', 'findMany', { limit: 11 })).toThrow(
      DataReadCeilingError,
    );
  });

  it('warn mode: honours a limit over the ceiling exactly and reports it', () => {
    const report = vi.fn();
    const policy = createReadCeilingPolicy({ maxRows: 10, mode: 'warn', report });
    const bound = planReadBound(policy, 'E', 'findMany', { limit: 500 });
    expect(bound.sqlLimit).toBe(500);
    expect(bound.check(500)).toBe(500);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'E',
        cause: 'limit-over-ceiling',
        limit: 500,
        ceiling: 10,
      }),
    );
  });

  it('error mode: bounds an unlimited read at ceiling + 1 and refuses the extra row', () => {
    const bound = planReadBound(error(), 'E', 'findMany', undefined);
    expect(bound.sqlLimit).toBe(11);
    expect(bound.check(10)).toBe(10);
    expect(() => bound.check(11)).toThrow(DataReadCeilingError);
  });

  it('warn mode: leaves an unlimited read unbounded and reports past the ceiling with the call site', () => {
    const events: ReadCeilingEvent[] = [];
    const policy = createReadCeilingPolicy({ maxRows: 10, report: (e) => events.push(e) });
    const bound = planReadBound(policy, 'E', 'findMany', {});
    expect(bound.sqlLimit).toBeUndefined();
    expect(bound.check(11)).toBe(11);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cause: 'result-over-ceiling', rows: 11, mode: 'warn' });
    expect(events[0]?.stack).toContain('read-ceiling.test');
  });

  it('unbounded: true skips the ceiling and keeps an explicit limit as given', () => {
    const report = vi.fn();
    const policy = createReadCeilingPolicy({ maxRows: 10, mode: 'error', report });
    const all = planReadBound(policy, 'E', 'findMany', { unbounded: true });
    expect(all.sqlLimit).toBeUndefined();
    expect(all.check(1_000_000)).toBe(1_000_000);
    expect(planReadBound(policy, 'E', 'findMany', { unbounded: true, limit: 5000 }).sqlLimit).toBe(
      5000,
    );
    expect(report).not.toHaveBeenCalled();
  });

  it('reports one call site at most once a minute, counting the repeats', () => {
    const events: ReadCeilingEvent[] = [];
    const policy = createReadCeilingPolicy({ maxRows: 1, report: (e) => events.push(e) });
    for (let i = 0; i < 5; i++) planReadBound(policy, 'E', 'findMany', {}).check(2);
    expect(events).toHaveLength(1);
  });

  it('refuses an invalid policy', () => {
    expect(() => createReadCeilingPolicy({ maxRows: 0 })).toThrow(DataValidationError);
    expect(() => createReadCeilingPolicy({ mode: 'loud' as never })).toThrow(DataValidationError);
  });

  it('builds a policy from the host configuration, defaulting to 1000 rows and warn', () => {
    const policy = readCeilingPolicyFromConfig(undefined);
    expect(policy).toMatchObject({ maxRows: 1000, mode: 'warn' });
    const warnings: unknown[] = [];
    const strict = readCeilingPolicyFromConfig(
      { readCeiling: 2, readCeilingMode: 'warn' },
      (message, metadata) => warnings.push({ message, metadata }),
    );
    planReadBound(strict, 'E', 'findMany', {}).check(3);
    expect(warnings).toHaveLength(1);
  });
});

describe('createRepository and the read ceiling', () => {
  it('error mode: an unlimited findMany past the ceiling throws instead of returning part of it', async () => {
    const { repo, calls } = repoWith(4, createReadCeilingPolicy({ maxRows: 3, mode: 'error' }));
    const error = await repo.findMany().catch((e: unknown) => e);
    expect(calls.limit).toBe(4);
    expect(error).toBeInstanceOf(DataReadCeilingError);
    expect((error as DataReadCeilingError).metadata).toMatchObject({
      reason: 'read-ceiling-exceeded',
      cause: 'result-over-ceiling',
      entity: 'Document',
      ceiling: 3,
    });
  });

  it('error mode: a result at the ceiling is returned whole', async () => {
    const { repo } = repoWith(3, createReadCeilingPolicy({ maxRows: 3, mode: 'error' }));
    expect(await repo.findMany()).toHaveLength(3);
  });

  it('warn mode: an unlimited findMany past the ceiling returns every row and is reported', async () => {
    const report = vi.fn();
    const { repo, calls } = repoWith(5, createReadCeilingPolicy({ maxRows: 3, report }));
    expect(await repo.findMany()).toHaveLength(5);
    expect(calls.limit).toBeUndefined();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'Document', operation: 'findMany', rows: 5 }),
    );
  });

  it('findManyFields and aggregate apply the same ceiling', async () => {
    const policy = createReadCeilingPolicy({ maxRows: 3, mode: 'error' });
    const { repo } = repoWith(4, policy);
    await expect(repo.findManyFields?.(undefined, ['title'])).rejects.toBeInstanceOf(
      DataReadCeilingError,
    );
    await expect(
      repo.aggregate(undefined, { groupBy: 'title', count: true }),
    ).rejects.toBeInstanceOf(DataReadCeilingError);
    await expect(
      repo.aggregate(undefined, { groupBy: 'title', count: true, limit: 50 }),
    ).rejects.toBeInstanceOf(DataReadCeilingError);
  });

  it('warn mode: a limit over the ceiling returns every row asked for, on every read path', async () => {
    const report = vi.fn();
    const policy = () => createReadCeilingPolicy({ maxRows: 3, report });

    const many = repoWith(7, policy());
    expect(await many.repo.findMany({}, { limit: 5 })).toHaveLength(5);
    expect(many.calls.limit).toBe(5);

    const fields = repoWith(7, policy());
    expect(await fields.repo.findManyFields?.(undefined, ['title'], { limit: 5 })).toHaveLength(5);
    expect(fields.calls.limit).toBe(5);

    const groups = repoWith(7, policy());
    expect(
      await groups.repo.aggregate(undefined, { groupBy: 'title', count: true, limit: 5 }),
    ).toHaveLength(5);
    expect(groups.calls.limit).toBe(5);

    // A page of 5 asks SQL for 6 rows to learn whether there is a next page.
    const pages = repoWith(7, policy());
    const page = await pages.repo.findPage?.(undefined, { limit: 5 });
    expect(page?.rows).toHaveLength(5);
    expect(page?.nextCursor).toBeTruthy();
    expect(pages.calls.limit).toBe(6);

    const operations = report.mock.calls.map(([event]) => event.operation);
    expect(operations).toEqual(['findMany', 'findManyFields', 'aggregate', 'findPage']);
    for (const [event] of report.mock.calls) {
      expect(event).toMatchObject({ cause: 'limit-over-ceiling', limit: 5, ceiling: 3 });
    }
  });

  it('error mode: a limit over the ceiling is refused on every read path, before any query', async () => {
    const policy = () => createReadCeilingPolicy({ maxRows: 3, mode: 'error' });
    const { repo, calls } = repoWith(7, policy());
    await expect(repo.findMany({}, { limit: 5 })).rejects.toBeInstanceOf(DataReadCeilingError);
    await expect(repo.findManyFields?.(undefined, ['title'], { limit: 5 })).rejects.toBeInstanceOf(
      DataReadCeilingError,
    );
    await expect(repo.findPage?.(undefined, { limit: 5 })).rejects.toBeInstanceOf(
      DataReadCeilingError,
    );
    expect(calls.limit).toBeUndefined();
  });

  it('{ unbounded: true } returns every row in error mode', async () => {
    const { repo, calls } = repoWith(7, createReadCeilingPolicy({ maxRows: 3, mode: 'error' }));
    expect(await repo.findMany({}, { unbounded: true })).toHaveLength(7);
    expect(calls.limit).toBeUndefined();
  });

  it('an EntityRegistry applies the policy it was configured with', async () => {
    const registry = new EntityRegistry();
    registry.register(entity);
    registry.configureReadCeiling(createReadCeilingPolicy({ maxRows: 2, mode: 'error' }));
    const { db } = queryDb(rows(3));
    const data = registry.createDataService({ db: db as never, auth }) as Record<
      string,
      { findMany(): Promise<unknown[]> }
    >;
    await expect(data.Document?.findMany()).rejects.toBeInstanceOf(DataReadCeilingError);
  });
});

describe('an empty IN list', () => {
  const dialect = new PgDialect();

  it('compiles to FALSE (matches no row) instead of dropping the filter', async () => {
    const { repo, calls } = repoWith(2);
    await repo.findMany({}, { in: { id: [] } });
    const where = dialect.sqlToQuery(calls.where as never);
    expect(where.sql).toContain('false');
  });

  it('applies to count and exists too', async () => {
    const select = vi.fn();
    const captured: unknown[] = [];
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: (w: unknown) => {
        captured.push(w);
        return chain;
      },
      limit: () => chain,
      then: (resolve: (value: unknown[]) => unknown) => resolve([{ count: 0 }]),
    };
    select.mockReturnValue(chain);
    const repo = createRepository({ entity, table, db: { select } as never, auth });
    await repo.count({}, { in: { id: [] } });
    await repo.exists?.({}, { in: { id: [] } });
    for (const where of captured) {
      expect(dialect.sqlToQuery(where as never).sql).toContain('false');
    }
    expect(captured).toHaveLength(2);
  });
});

describe('keyset cursors', () => {
  const keys = resolveKeysetKeys([{ column: 'createdAt', dir: 'desc' }], undefined);

  it('always ends the order on id, in the direction of the last key', () => {
    expect(keys).toEqual([
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ]);
    expect(resolveKeysetKeys(undefined, undefined)).toEqual([{ column: 'id', dir: 'asc' }]);
  });

  it('round-trips dates, strings and numbers', () => {
    const at = new Date('2026-11-19T10:00:00.000Z');
    const cursor = encodeKeysetCursor('E', keys, { createdAt: at, id: 'abc' });
    expect(decodeKeysetCursor('E', keys, cursor)).toEqual([at, 'abc']);
  });

  it('refuses a cursor of another sort, and garbage', () => {
    const cursor = encodeKeysetCursor('E', keys, { createdAt: new Date(), id: 'abc' });
    const other = resolveKeysetKeys('title', 'asc');
    expect(() => decodeKeysetCursor('E', other, cursor)).toThrow(DataValidationError);
    expect(() => decodeKeysetCursor('E', keys, 'not-a-cursor')).toThrow(DataValidationError);
  });

  it('refuses to end a page on a NULL sort key', () => {
    expect(() => encodeKeysetCursor('E', keys, { createdAt: null, id: 'abc' })).toThrow(
      DataValidationError,
    );
  });
});
