import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { defineEntity } from '../../define/defineEntity.js';
import { field } from '../../fields/index.js';
import { startPostgres } from '../../flows/__tests__/postgres-fixture.js';
import { createInMemoryRepository } from '../../testing/index.js';
import { createRepository, generateDrizzleSchema } from '../index.js';
import type { Repository } from '../../types/context.js';

const entity = defineEntity({
  name: 'ProjectionDocument',
  tenantScoped: true,
  fields: {
    id: field.id(),
    title: field.string(),
    body: field.string(),
    secret: field.string({ encrypted: true, classification: 'sensitive' }),
    deletedAt: field.timestamp({ nullable: true }),
  },
});
const table = generateDrizzleSchema(entity);
type Document = { id: string; title: string; body: string; secret: string; deletedAt: Date | null };
const auth = { userId: 'user', tenantId: 'one', roles: ['user'], scopes: [], provider: 'test' };
const encryptionKey = Buffer.alloc(32, 7);
let pg: Awaited<ReturnType<typeof startPostgres>>;
let repo: ReturnType<typeof createRepository<Document>>;
const queries: string[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ table }),
  )) {
    await pg.sql.unsafe(statement);
  }
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.sql`TRUNCATE projection_document`;
  const db = drizzle(pg.sql, {
    logger: {
      logQuery: (query) => {
        queries.push(query);
      },
    },
  });
  repo = createRepository<Document>({ entity, table, db, auth, encryptionKey, softDelete: true });
  await repo.create({
    title: 'A',
    body: 'unneeded'.repeat(1000),
    secret: 'first',
    deletedAt: null,
  });
  await repo.create({
    title: 'B',
    body: 'unneeded'.repeat(1000),
    secret: 'second',
    deletedAt: null,
  });
  await repo.create({ title: 'Deleted', body: 'hidden', secret: 'deleted', deletedAt: new Date() });
  const other = createRepository<Document>({
    entity,
    table,
    db,
    auth: { ...auth, tenantId: 'two' },
    encryptionKey,
  });
  await other.create({ title: 'Other tenant', body: 'hidden', secret: 'other', deletedAt: null });
  queries.length = 0;
});

describe('repository field projection', () => {
  it('selects only requested columns while retaining tenant, deletion, sorting and pagination', async () => {
    const rows = await repo.findManyFields({}, ['title'], {
      orderBy: 'title',
      orderDir: 'asc',
      offset: 1,
      limit: 1,
    });
    expectTypeOf(rows).toEqualTypeOf<Pick<Document, 'title'>[]>();
    expect(rows).toEqual([{ title: 'B' }]);
    expect(queries[0]).toMatch(/^select "title" from/);
    expect(queries[0]).toContain('"tenant_id"');
    expect(queries[0]).toContain('"deleted_at" is null');
    expect(queries[0]).not.toContain('"body"');
    const full = await repo.findMany({ title: 'A' });
    expectTypeOf(full).toEqualTypeOf<Document[]>();
    expect(full[0]).toMatchObject({ title: 'A', secret: 'first', body: 'unneeded'.repeat(1000) });
  });

  it('decrypts selected secrets and does not load or decrypt an omitted corrupt secret', async () => {
    expect(await repo.findManyFields({ title: 'A' }, ['secret'])).toEqual([{ secret: 'first' }]);
    await pg.sql`UPDATE projection_document SET secret = 'plumbus:enc:v1:invalid' WHERE title = 'A'`;
    expect(await repo.findManyFields({ title: 'A' }, ['title'])).toEqual([{ title: 'A' }]);
    await expect(repo.findManyFields({ title: 'A' }, ['secret'])).rejects.toThrow();
    await expect(repo.findManyFields({ secret: 'first' }, ['title'])).rejects.toThrow(/encrypted/);
  });

  it('fails closed for malformed projections without querying or returning full rows', async () => {
    for (const select of [
      [],
      ['missing'],
      ['__proto__'],
      ['constructor'],
      'title',
      null,
      undefined,
      [1],
    ]) {
      await expect(repo.findManyFields({}, select as any)).rejects.toMatchObject({
        code: 'validation',
      });
    }
    expect(queries).toHaveLength(0);
    expect(await repo.findManyFields({ title: 'A' }, ['title', 'title'])).toEqual([{ title: 'A' }]);
  });

  it('still rejects missing tenant context even when tenantId is not selected', async () => {
    const denied = createRepository<Document>({
      entity,
      table,
      db: pg.db,
      auth: { ...auth, tenantId: undefined },
    });
    await expect(denied.findManyFields({}, ['title'])).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('mirrors projected results in the schema-less in-memory test repository', async () => {
    const memory = createInMemoryRepository<Document>([
      { id: '1', title: 'A', body: 'large', secret: 'first', deletedAt: null },
      { id: '2', title: 'B', body: 'large', secret: 'second', deletedAt: null },
    ]);
    const rows = await memory.findManyFields({}, ['title'], {
      orderBy: 'title',
      orderDir: 'asc',
      offset: 1,
      limit: 1,
    });
    expectTypeOf(rows).toEqualTypeOf<Pick<Document, 'title'>[]>();
    expect(rows).toEqual([{ title: 'B' }]);
    await expect(memory.findManyFields({}, [])).rejects.toMatchObject({ code: 'validation' });
    expect((await memory.findMany())[0]).toMatchObject({ body: 'large' });
  });

  it('keeps findMany callable on a union of repositories', async () => {
    type Note = { id: string; text: string };
    const notes = createInMemoryRepository<Note>([{ id: 'n', text: 'kept' }]);
    const memory = createInMemoryRepository<Document>([
      { id: '1', title: 'A', body: 'large', secret: 'first', deletedAt: null },
    ]);
    const repos: Record<string, Repository<Document> | Repository<Note>> = { notes, memory };
    for (const repository of Object.values(repos)) {
      expect(await repository.findMany({})).toHaveLength(1);
    }
  });
});
