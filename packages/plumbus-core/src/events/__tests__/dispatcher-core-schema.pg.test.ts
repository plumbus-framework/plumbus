/**
 * The outbox dispatcher must read each plane's `dispatch_outbox` from the schema the flow
 * engine writes it under — never from the plane handle's `coreSchema` (Quinovium #202).
 *
 * The engine persists an acceptance under `spineDispatch.coreSchema ?? PLUMBUS_FRAMEWORK_SCHEMA
 * ?? core_plumbus`. A handle's `coreSchema` is a different thing: the schema of the tenant's
 * own entity tables, which a host may leave at `public` while the durable tables sit in the
 * framework schema. Reading `dispatch_outbox` off the handle answered `relation
 * "dispatch_outbox" does not exist` for every tenant on every poll, and the retry path for an
 * acceptance persisted but never published never worked. The pump now resolves the schema the
 * way the engine does, and the host's `frameworkSchema` reaches it the way it reaches the engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { persistAcceptanceOnDb } from '../../durable/postgres-persist.js';
import { createOutboxDispatcher } from '../dispatcher.js';
import { createInMemoryQueue } from '../queue.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';

describe('the pump reads dispatch_outbox where the engine writes it', () => {
  let harness: DurableTestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  async function persistOne(executionId: string, schema: string): Promise<void> {
    await persistAcceptanceOnDb(
      harness.tenantDb,
      {
        executionId,
        tenantRef: 'tenant-a',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        firstStepId: 'step-a',
        correlationId: `corr-${executionId}`,
        nowIso: new Date().toISOString(),
      },
      schema,
    );
  }

  async function publishedOnSpine(executionId: string): Promise<number> {
    const rows = await harness.spineDb.execute(sql`
      SELECT execution_id FROM opaque_dispatch WHERE execution_id = ${executionId}
    `);
    return (rows as unknown as unknown[]).length;
  }

  it('drains a plane whose handle says `public` while the durable tables sit in the framework default schema', async () => {
    // A host that configures nothing: the harness provisions under the framework default, the
    // engine writes there, and the handle — as Quinovium's resolver builds it — says `public`.
    harness = await createDurableTestHarness({ includeEventOutbox: true });
    await persistOne('exec-default-schema', harness.coreSchema);

    const dispatcher = createOutboxDispatcher({
      db: harness.spineDb,
      queue: createInMemoryQueue(),
      resolver: createSingleDataPlaneResolver(harness.tenantDb, { coreSchema: 'public' }),
      listTenantRefs: async () => ['tenant-a'],
      spineDb: harness.spineDb,
    });

    expect(await dispatcher.poll()).toBeGreaterThanOrEqual(1);
    expect(await publishedOnSpine('exec-default-schema')).toBe(1);
  });

  it('drains a plane under the schema the host configured, whatever the handle names', async () => {
    harness = await createDurableTestHarness({
      includeEventOutbox: true,
      coreSchema: 'core_host_named',
    });
    await persistOne('exec-host-schema', 'core_host_named');

    const dispatcher = createOutboxDispatcher({
      db: harness.spineDb,
      queue: createInMemoryQueue(),
      // The handle names yet another schema: it is the entity tables' namespace, not the pump's.
      resolver: createSingleDataPlaneResolver(harness.tenantDb, { coreSchema: 'app_entities' }),
      listTenantRefs: async () => ['tenant-a'],
      spineDb: harness.spineDb,
      frameworkSchema: 'core_host_named',
    });

    expect(await dispatcher.poll()).toBeGreaterThanOrEqual(1);
    expect(await publishedOnSpine('exec-host-schema')).toBe(1);
  });
});
