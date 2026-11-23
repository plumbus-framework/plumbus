// Audit outbox against two real PostgreSQL databases: a ledger database holding
// `audit_records` (the spine) and a tenant database holding the work and `audit_outbox`.
// Each pool holds ONE connection, so a record written to the ledger while the tenant
// transaction is open would have to wait for the ledger's only connection.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository } from '../../data/repository.js';
import { generateDrizzleSchema } from '../../data/schema-generator.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { field } from '../../fields/index.js';
import type { AuthContext } from '../../types/security.js';
import type { PlumbusConfig } from '../../types/config.js';
import { createInMemoryQueue } from '../../events/queue.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import { createWorkerPool } from '../../worker/index.js';
import {
  auditOutboxDdl,
  createAuditOutbox,
  relayAuditOutbox,
  runWithAuditOutbox,
} from '../outbox.js';
import { type AuditWriteFailure, createAuditService } from '../service.js';
import { createDatabaseAuditWriter } from '../writer.js';

const AUDIT_DDL = `
  CREATE TABLE audit_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor text NOT NULL,
    tenant_id text,
    "timestamp" timestamptz NOT NULL DEFAULT now(),
    component text NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL,
    metadata jsonb,
    masked_fields jsonb
  );
  CREATE TABLE refuse_all (on_off boolean NOT NULL);
  INSERT INTO refuse_all VALUES (false);
  CREATE FUNCTION refuse_records() RETURNS trigger AS $$
  BEGIN
    IF (SELECT on_off FROM refuse_all) THEN RAISE EXCEPTION 'ledger refuses'; END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
  CREATE TRIGGER refuse_records BEFORE INSERT ON audit_records
    FOR EACH ROW EXECUTE FUNCTION refuse_records()
`;

const INVOICE_DDL = `
  CREATE TABLE invoice (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number text NOT NULL,
    customer_email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

const invoiceEntity = {
  name: 'Invoice',
  fields: {
    id: field.id(),
    number: field.string({ required: true }),
    customerEmail: field.string({ maskedInLogs: true }),
  },
} as never;

const auth: AuthContext = {
  userId: 'clerk-1',
  roles: ['clerk'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-a',
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Splits a DDL script on `;` outside `$$ … $$` bodies. */
async function apply(db: PostgresJsDatabase, ddl: string): Promise<void> {
  const parts = ddl.split('$$');
  const statements: string[] = [];
  let current = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      current += `$$${part}$$`;
      return;
    }
    const pieces = part.split(';');
    current += pieces[0];
    for (const piece of pieces.slice(1)) {
      statements.push(current);
      current = piece;
    }
  });
  statements.push(current);
  for (const statement of statements.map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }
}

async function fixture(options: { outboxTable?: boolean } = {}) {
  const ledger = await createDurableTestDatabase({ kind: 'audit_ledger', ddl: '' });
  closers.push(() => ledger.close());
  await apply(ledger.db, AUDIT_DDL);
  const tenant = await createDurableTestDatabase({ kind: 'audit_tenant', ddl: '' });
  closers.push(() => tenant.close());
  await apply(tenant.db, INVOICE_DDL);
  if (options.outboxTable !== false) await apply(tenant.db, auditOutboxDdl());
  const failures: AuditWriteFailure[] = [];
  // The request's audit service: the ledger's default database service (as `ctx.audit`).
  const audit = createAuditService({
    db: ledger.db,
    auth,
    component: 'billing',
    onWriteFailure: (failure) => failures.push(failure),
  });
  const table = generateDrizzleSchema(invoiceEntity);
  const repository = (db: PostgresJsDatabase, recordWith: typeof audit) =>
    createRepository({ entity: invoiceEntity, table, db, auth, audit: recordWith });
  const rows = async <T>(db: PostgresJsDatabase, query: ReturnType<typeof sql>) =>
    (await db.execute(query)) as unknown as T[];
  return {
    ledger: ledger.db,
    tenant: tenant.db,
    audit,
    failures,
    repository,
    ledgerRecords: () =>
      rows<{ id: string; action: string; outcome: string; metadata: Record<string, unknown> }>(
        ledger.db,
        sql`SELECT id::text, action, outcome, metadata FROM audit_records ORDER BY "timestamp", action`,
      ),
    outboxIds: async () =>
      (
        await rows<{ id: string }>(tenant.db, sql`SELECT id::text FROM audit_outbox ORDER BY id`)
      ).map((row) => row.id),
    invoices: async () =>
      (
        await rows<{ number: string }>(tenant.db, sql`SELECT number FROM invoice ORDER BY number`)
      ).map((row) => row.number),
    refuseLedger: (on: boolean) => ledger.db.execute(sql`UPDATE refuse_all SET on_off = ${on}`),
    makeDue: () =>
      tenant.db.execute(sql`UPDATE audit_outbox SET next_attempt_at = now() - interval '1 second'`),
  };
}

/** Resolves `work`, or rejects when it takes longer than `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`waited ${ms} ms`)), ms)),
  ]);
}

describe('audit outbox', () => {
  it('holds the records in the tenant transaction and hands them to the ledger after commit', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('a default audit service must give an outbox');
    let insideTx: { outbox: number; ledger: number } | undefined;
    await f.tenant.transaction(async (tx) => {
      const invoices = f.repository(tx as never, outbox.bind(tx as never));
      await invoices.create({ number: 'INV-1', customerEmail: 'a@example.com' });
      await invoices.create({ number: 'INV-2' });
      const held = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM audit_outbox`,
      )) as unknown as Array<{ n: number }>;
      insideTx = { outbox: held[0]?.n ?? -1, ledger: (await f.ledgerRecords()).length };
    });
    expect(insideTx).toEqual({ outbox: 2, ledger: 0 });
    // Committed, not yet flushed: the records are durable in the tenant database.
    expect((await f.outboxIds()).length).toBe(2);
    const outboxIds = await f.outboxIds();
    expect(await outbox.flush(f.tenant)).toEqual({ delivered: 2, left: 0 });
    const records = await f.ledgerRecords();
    expect(records.map((r) => [r.action, r.outcome])).toEqual([
      ['Invoice.create', 'success'],
      ['Invoice.create', 'success'],
    ]);
    // Same ids end to end, masked fields still masked.
    expect(records.map((r) => r.id).sort()).toEqual(outboxIds);
    expect(JSON.stringify(records)).not.toContain('a@example.com');
    expect(await f.outboxIds()).toEqual([]);
  });

  it('leaves no record of a transaction that rolled back, and a flush after it writes nothing', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await expect(
      f.tenant.transaction(async (tx) => {
        await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-9' });
        throw new Error('the work failed after its write');
      }),
    ).rejects.toThrow('the work failed');
    expect(await f.invoices()).toEqual([]);
    expect(await f.outboxIds()).toEqual([]);
    expect(await outbox.flush(f.tenant)).toEqual({ delivered: 0, left: 0 });
    expect(await f.ledgerRecords()).toEqual([]);
  });

  it('never waits for a ledger connection while the tenant transaction is open', async () => {
    const f = await fixture();
    let releaseLedger!: () => void;
    const ledgerBusy = new Promise<void>((resolve) => {
      releaseLedger = resolve;
    });
    // Another request holds the ledger's only connection.
    const holder = f.ledger.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await ledgerBusy;
    });
    let control: Promise<unknown> | undefined;
    try {
      // With the outbox the work commits while the ledger stays busy.
      const outbox = createAuditOutbox(f.audit);
      if (!outbox) throw new Error('no outbox');
      await within(
        f.tenant.transaction(async (tx) => {
          await f
            .repository(tx as never, outbox.bind(tx as never))
            .create({ number: 'INV-OUTBOX' });
        }),
        1_000,
      );
      expect(await f.outboxIds()).toHaveLength(1);
      // Control: the same work recording straight to the ledger stalls inside its transaction.
      control = f.tenant.transaction(async (tx) => {
        await f.repository(tx as never, f.audit).create({ number: 'INV-DIRECT' });
      });
      await expect(within(control, 1_000)).rejects.toThrow('waited 1000 ms');
    } finally {
      releaseLedger();
      await holder;
      await control;
    }
  });

  it('keeps what the ledger refuses for the relay, reports it, and the relay delivers it once', async () => {
    const f = await fixture();
    await f.refuseLedger(true);
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await f.tenant.transaction(async (tx) => {
      await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-3' });
    });
    expect(await outbox.flush(f.tenant)).toEqual({ delivered: 0, left: 1 });
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]?.final).toBe(false);
    expect(await f.outboxIds()).toHaveLength(1);
    expect(await f.ledgerRecords()).toEqual([]);

    const writer = createDatabaseAuditWriter(f.ledger);
    // Not due yet: the relay leaves rows a flush may still take.
    await f.refuseLedger(false);
    expect(await relayAuditOutbox(f.tenant, { writer })).toEqual({ delivered: 0, failed: 0 });
    await f.makeDue();
    expect(await relayAuditOutbox(f.tenant, { writer })).toEqual({ delivered: 1, failed: 0 });
    expect((await f.ledgerRecords()).map((r) => r.action)).toEqual(['Invoice.create']);
    expect(await f.outboxIds()).toEqual([]);
  });

  it('delivers the records of a unit whose process stopped after the commit (no flush)', async () => {
    const f = await fixture();
    await runWithAuditOutbox(f.audit, f.tenant, async (tx, audit) => {
      await f.repository(tx, audit).create({ number: 'INV-4' });
    });
    // `runWithAuditOutbox` flushed; simulate a second unit that never flushed.
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await f.tenant.transaction(async (tx) => {
      await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-5' });
    });
    expect((await f.ledgerRecords()).length).toBe(1);
    await f.makeDue();
    const writer = createDatabaseAuditWriter(f.ledger);
    expect(await relayAuditOutbox(f.tenant, { writer })).toEqual({ delivered: 1, failed: 0 });
    expect((await f.ledgerRecords()).length).toBe(2);
  });

  it('stores a record handed over twice once (same id), and the relay clears it', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await f.tenant.transaction(async (tx) => {
      await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-6' });
    });
    const [id] = await f.outboxIds();
    // As if a flush delivered and then could not delete its row.
    const [held] = (await f.tenant.execute(
      sql`SELECT record FROM audit_outbox WHERE id = ${id}::uuid`,
    )) as unknown as Array<{ record: Record<string, unknown> }>;
    await createDatabaseAuditWriter(f.ledger).write({
      ...(held?.record as never),
      id,
      timestamp: new Date(),
    });
    await f.makeDue();
    expect(
      await relayAuditOutbox(f.tenant, { writer: createDatabaseAuditWriter(f.ledger) }),
    ).toEqual({
      delivered: 1,
      failed: 0,
    });
    expect((await f.ledgerRecords()).map((r) => r.id)).toEqual([id]);
    expect(await f.outboxIds()).toEqual([]);
  });

  it('writes refusals to the ledger at once: they stand even when the work rolls back', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await expect(
      f.tenant.transaction(async (tx) => {
        const audit = outbox.bind(tx as never);
        await audit.record('Invoice.tenant_denied', { outcome: 'denied', reason: 'test' });
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect((await f.ledgerRecords()).map((r) => [r.action, r.outcome])).toEqual([
      ['Invoice.tenant_denied', 'denied'],
    ]);
    expect(await f.outboxIds()).toEqual([]);
  });

  it('refuses with a hint when the tenant database has no audit_outbox', async () => {
    const f = await fixture({ outboxTable: false });
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await expect(
      f.tenant.transaction(async (tx) => {
        await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-7' });
      }),
    ).rejects.toThrow(/audit_outbox is missing.*plumbus migrate generate/);
    expect(await f.invoices()).toEqual([]);
    // The relay leaves such a database alone.
    expect(
      await relayAuditOutbox(f.tenant, { writer: createDatabaseAuditWriter(f.ledger) }),
    ).toEqual({
      delivered: 0,
      failed: 0,
    });
  });

  it('gives no outbox over a service with its own writer', () => {
    const custom = createAuditService({
      db: {} as never,
      auth,
      writer: { write: async () => undefined },
    });
    expect(createAuditOutbox(custom)).toBeUndefined();
    expect(createAuditOutbox({ record: async () => undefined })).toBeUndefined();
  });

  it('is relayed by the worker pool from every listed tenant plane when turned on', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await f.tenant.transaction(async (tx) => {
      await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-8' });
    });
    await f.makeDue();
    const pool = createWorkerPool({
      config: { environment: 'test' } as PlumbusConfig,
      db: f.ledger,
      flows: new FlowRegistry(),
      consumers: new ConsumerRegistry(),
      queue: createInMemoryQueue(),
      audit: { record: async () => {} },
      dataPlaneResolver: createSingleDataPlaneResolver(f.tenant),
      listTenantRefs: () => ['tenant-a'],
      enableScheduler: false,
      enableDispatcher: false,
      enableEventWorker: false,
      enableFlowRunner: false,
      auditOutboxRelayIntervalMs: 50,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      stepDeps: {
        async executeCapability() {
          return { success: true, data: {} };
        },
        evaluateCondition: () => true,
      },
    });
    await pool.start();
    try {
      await expect
        .poll(async () => (await f.ledgerRecords()).map((r) => r.action), {
          timeout: 10_000,
          interval: 50,
        })
        .toEqual(['Invoice.create']);
      expect(await f.outboxIds()).toEqual([]);
    } finally {
      await pool.stop();
    }
  }, 30_000);

  it('reports to the host hook when the worker relay cannot deliver, and keeps the records', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await f.tenant.transaction(async (tx) => {
      await f.repository(tx as never, outbox.bind(tx as never)).create({ number: 'INV-10' });
    });
    await f.makeDue();
    await f.refuseLedger(true);
    const reported: AuditWriteFailure[] = [];
    const pool = createWorkerPool({
      config: { environment: 'test' } as PlumbusConfig,
      db: f.ledger,
      flows: new FlowRegistry(),
      consumers: new ConsumerRegistry(),
      queue: createInMemoryQueue(),
      audit: { record: async () => {} },
      dataPlaneResolver: createSingleDataPlaneResolver(f.tenant),
      listTenantRefs: () => ['tenant-a'],
      enableScheduler: false,
      enableDispatcher: false,
      enableEventWorker: false,
      enableFlowRunner: false,
      auditOutboxRelayIntervalMs: 50,
      onAuditWriteFailure: (failure) => reported.push(failure),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      stepDeps: {
        async executeCapability() {
          return { success: true, data: {} };
        },
        evaluateCondition: () => true,
      },
    });
    await pool.start();
    try {
      await expect
        .poll(() => reported.length, { timeout: 10_000, interval: 50 })
        .toBeGreaterThan(0);
      expect(reported[0]).toMatchObject({ final: false });
      expect(await f.outboxIds()).toHaveLength(1);
      expect(await f.ledgerRecords()).toEqual([]);
    } finally {
      await pool.stop();
    }
  }, 30_000);

  it('relays at most its limit per call', async () => {
    const f = await fixture();
    const outbox = createAuditOutbox(f.audit);
    if (!outbox) throw new Error('no outbox');
    await f.tenant.transaction(async (tx) => {
      const invoices = f.repository(tx as never, outbox.bind(tx as never));
      for (let i = 0; i < 25; i += 1) await invoices.create({ number: `INV-L${i}` });
    });
    await f.makeDue();
    const writer = createDatabaseAuditWriter(f.ledger);
    expect(await relayAuditOutbox(f.tenant, { writer, limit: 10 })).toEqual({
      delivered: 10,
      failed: 0,
    });
    expect(await f.outboxIds()).toHaveLength(15);
    expect((await f.ledgerRecords()).length).toBe(10);
  });
});
