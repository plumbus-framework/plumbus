/**
 * The outbox dispatcher must read each resolved plane's `dispatch_outbox` from the schema the
 * plane's handle names — not from `public` (Quinovium #202).
 *
 * A host that provisions tenant planes with a named framework schema (`core_plumbus` or
 * anything other than the default) and a default descriptor that leaves `coreSchema` unset
 * used to make the pump answer `relation "dispatch_outbox" does not exist` for every tenant on
 * every poll: the handle said `public`, the tables lived in the named schema. The pump takes
 * the schema off the handle, so the qualification follows the placement — and the pump's
 * no-resolver default plane reads the framework schema the host configured, which is where a
 * spine's own durable tables live when `PLUMBUS_FRAMEWORK_SCHEMA` is set.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { persistAcceptanceOnDb } from '../../durable/postgres-persist.js';
import { createOutboxDispatcher } from '../dispatcher.js';
import { createInMemoryQueue } from '../queue.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';

describe('the pump qualifies dispatch_outbox by the plane handle’s core schema', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('drains a tenant plane whose core schema is not `public`', async () => {
    harness = await createDurableTestHarness({ includeEventOutbox: true });
    // The handle is resolved with NO coreSchema — the exact shape a descriptor that leaves
    // the name unset produces. The pump has to fall back to the framework schema, and the
    // harness provisions the durable tables under that same name.
    const resolver = createSingleDataPlaneResolver(harness.tenantDb);

    const nowIso = new Date().toISOString();
    await persistAcceptanceOnDb(
      harness.tenantDb,
      {
        executionId: 'exec-named-schema',
        tenantRef: 'tenant-a',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        firstStepId: 'step-a',
        correlationId: 'corr-named',
        nowIso,
      },
      harness.coreSchema,
    );

    const queue = createInMemoryQueue();
    const dispatcher = createOutboxDispatcher({
      db: harness.spineDb,
      queue,
      resolver,
      listTenantRefs: async () => ['tenant-a'],
      spineDb: harness.spineDb,
    });

    const count = await dispatcher.poll();
    expect(count).toBeGreaterThanOrEqual(1);

    const spineRows = await harness.spineDb.execute(sql`
      SELECT execution_id FROM opaque_dispatch WHERE execution_id = 'exec-named-schema'
    `);
    expect((spineRows as unknown as unknown[]).length).toBe(1);
  });
});