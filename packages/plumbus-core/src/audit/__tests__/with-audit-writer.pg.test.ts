// `withAuditWriter(service, writer)`: the same audit service (actor, tenant, component) writing
// through an app's own writer — also for `ctx.audit` inside a framework transaction.

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EntityRegistry } from '../../data/registry.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { EventRegistry } from '../../events/registry.js';
import { executeCapability } from '../../execution/capability-executor.js';
import { buildCapabilityRuntimeDeps } from '../../execution/capability-invocation.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { createExecutionContext } from '../../execution/context-factory.js';
import { wireContextDependencies } from '../../execution/context-deps.js';
import type { AuditEvent, AuditService } from '../../types/audit.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { AuthContext } from '../../types/security.js';
import { createAuditService, withAuditWriter } from '../service.js';
import { createDatabaseAuditWriter } from '../writer.js';

const auth: AuthContext = {
  userId: 'clerk-1',
  roles: ['clerk'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-a',
};

const AUDIT_DDL = `CREATE TABLE audit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text NOT NULL, tenant_id text,
  "timestamp" timestamptz NOT NULL DEFAULT now(), component text NOT NULL, action text NOT NULL,
  outcome text NOT NULL, metadata jsonb, masked_fields jsonb)`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function collecting(): { writer: { write(e: AuditEvent): Promise<void> }; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, writer: { write: async (event) => void events.push(event) } };
}

describe('withAuditWriter', () => {
  it('keeps the actor, tenant and component and gives each record its id', async () => {
    const outer = createAuditService({ db: {} as never, auth, component: 'billing' });
    const { writer, events } = collecting();
    const service = withAuditWriter(outer, writer);
    if (!service) throw new Error('a framework service can be rebound');
    await service.record('Invoice.create', {
      number: 'INV-1',
      customerEmail: 'a@example.com',
      _maskedFields: ['customerEmail'],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'clerk-1',
      tenantId: 'tenant-a',
      component: 'billing',
      action: 'Invoice.create',
      outcome: 'success',
    });
    expect(events[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(withAuditWriter(outer, writer, { component: 'ledger' })).toBeDefined();
  });

  it('returns undefined for a service the framework did not build', () => {
    const custom: AuditService = { record: async () => undefined };
    expect(withAuditWriter(custom, collecting().writer)).toBeUndefined();
  });

  it.each([
    'eager',
    'lazy',
  ] as const)('rebinds ctx.audit inside a framework transaction (%s), and the records can be handed on once', async (begin) => {
    const handle = await createDurableTestDatabase({ kind: 'with_audit_writer', ddl: AUDIT_DDL });
    closers.push(() => handle.close());
    const db = handle.db;
    const kept: AuditEvent[] = [];
    let rebound = false;
    const capability = {
      name: 'issueInvoice',
      kind: 'action',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['clerk'] },
      transactional: begin,
      handler: async (ctx: { audit: AuditService }) => {
        const own = withAuditWriter(ctx.audit, { write: async (event) => void kept.push(event) });
        rebound = own !== undefined;
        await own?.record('Invoice.issue', { number: 'INV-2' });
        return { ok: true };
      },
    } as unknown as CapabilityContract;
    const registry = new CapabilityRegistry();
    registry.registerAll([capability]);
    const audit = createAuditService({ db, auth, component: 'billing' });
    const deps = wireContextDependencies(
      { db, auth, entities: new EntityRegistry(), events: new EventRegistry(), audit },
      { config: {}, ...buildCapabilityRuntimeDeps(registry) },
    );
    const result = await executeCapability(capability, createExecutionContext(deps), {});
    expect(result.success).toBe(true);
    expect(rebound).toBe(true);
    expect(kept.map((event) => [event.action, event.actor, event.tenantId])).toEqual([
      ['Invoice.issue', 'clerk-1', 'tenant-a'],
    ]);
    // Handing the same record over twice stores it once (same id).
    const ledger = createDatabaseAuditWriter(db);
    await ledger.writeMany?.(kept);
    await ledger.writeMany?.(kept);
    const rows = (await db.execute(
      sql`SELECT id::text, action FROM audit_records WHERE action = 'Invoice.issue'`,
    )) as unknown as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual([kept[0]?.id]);
  });
});
