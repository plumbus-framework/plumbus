import { describe, expect, it, vi } from 'vitest';
import { createReadCeilingPolicy } from '../../data/index.js';
import { DataReadCeilingError } from '../../errors/index.js';
import { createInMemoryRepository, createTestContext } from '../index.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, n: i }));

describe('in-memory repository reads follow the Drizzle repository', () => {
  it('an empty IN list matches nothing (findMany, count, exists)', async () => {
    const repo = createInMemoryRepository(rows(3));
    expect(await repo.findMany({}, { in: { id: [] } })).toEqual([]);
    expect(await repo.count({}, { in: { id: [] } })).toBe(0);
    expect(await repo.exists?.({}, { in: { id: [] } })).toBe(false);
    expect(await repo.exists?.({}, { in: { id: ['r1'] } })).toBe(true);
  });

  it('honours limit exactly, 0 included', async () => {
    const repo = createInMemoryRepository(rows(150));
    expect(await repo.findMany({}, { limit: 120 })).toHaveLength(120);
    expect(await repo.findMany({}, { limit: 0 })).toEqual([]);
  });

  it('applies the read ceiling: reported in warn mode, refused in error mode', async () => {
    const report = vi.fn();
    const warn = createInMemoryRepository(rows(5), {
      entityName: 'Thing',
      readCeiling: createReadCeilingPolicy({ maxRows: 3, report }),
    });
    expect(await warn.findMany()).toHaveLength(5);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ entity: 'Thing', rows: 5 }));

    const strict = createInMemoryRepository(rows(5), {
      readCeiling: createReadCeilingPolicy({ maxRows: 3, mode: 'error' }),
    });
    await expect(strict.findMany()).rejects.toBeInstanceOf(DataReadCeilingError);
    expect(await strict.findMany({}, { unbounded: true })).toHaveLength(5);
  });

  it('warn mode honours a limit over the ceiling exactly (findMany, findManyFields, findPage, aggregate)', async () => {
    const report = vi.fn();
    const repo = createInMemoryRepository(rows(7), {
      entityName: 'Thing',
      readCeiling: createReadCeilingPolicy({ maxRows: 3, report }),
    });
    expect(await repo.findMany({}, { limit: 5 })).toHaveLength(5);
    expect(await repo.findManyFields?.(undefined, ['id'], { limit: 5 })).toHaveLength(5);
    const page = await repo.findPage?.(undefined, { limit: 5 });
    expect(page?.rows).toHaveLength(5);
    expect(page?.nextCursor).toBeTruthy();
    expect(await repo.aggregate(undefined, { groupBy: 'id', count: true, limit: 5 })).toHaveLength(
      5,
    );
    expect(report).toHaveBeenCalledTimes(4);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'limit-over-ceiling', limit: 5, ceiling: 3 }),
    );
  });

  it('createTestContext({ readCeiling }) makes an over-ceiling read fail the test', async () => {
    const ctx = createTestContext({
      data: { Thing: rows(4) },
      readCeiling: createReadCeilingPolicy({ maxRows: 2, mode: 'error' }),
    });
    await expect(ctx.data.Thing?.findMany()).rejects.toBeInstanceOf(DataReadCeilingError);
  });

  it('findPage walks every row once with a cursor', async () => {
    const repo = createInMemoryRepository(rows(10));
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await repo.findPage?.(undefined, {
        limit: 3,
        orderBy: [{ column: 'n', dir: 'desc' }],
        ...(after ? { after } : {}),
      });
      ids.push(...(page?.rows ?? []).map((row) => row.id as string));
      after = page?.nextCursor ?? undefined;
    } while (after);
    expect(ids).toEqual(
      rows(10)
        .map((row) => row.id)
        .reverse(),
    );
  });
});
