import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rewriteFrameworkDriftMigration } from '../../data/framework-migration-rewriter.js';
import { defineCapability, defineFlow } from '../../define/index.js';
import { createDurableTestDatabase, flowExecutionsDdl } from '../../durable/index.js';
import { createExecutionContext, executeCapability } from '../../execution/index.js';
import { createFlowEngine } from '../../flows/engine.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { CompletedTelemetrySpan } from '../index.js';

// These are real database round trips; no transport or vendor SDK is installed.
describe('persisted telemetry privacy', () => {
  it.each([
    '00',
    '01',
  ])('retains %s across engine recreation without exporting input/auth', async (flags) => {
    const database = await createDurableTestDatabase({
      kind: 'telemetry_carrier',
      ddl: flowExecutionsDdl(),
    });
    const secret = 'PRIVATE-input-user-tenant';
    const auth = { userId: secret, tenantId: secret, roles: [], scopes: [], provider: 'test' };
    const parent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-${flags}`;
    const seen: CompletedTelemetrySpan[] = [];
    const hook = (span: CompletedTelemetrySpan) => {
      seen.push(span);
    };
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'carry',
        domain: 'telemetry',
        input: z.object({ value: z.string() }),
        steps: [
          {
            name: 'read',
            type: 'capability',
            capability: 'telemetry.read',
            input: { value: '$input.value' },
          },
        ],
      }),
    );
    const capability = defineCapability({
      name: 'read',
      domain: 'telemetry',
      kind: 'query',
      access: { public: true },
      input: z.object({ value: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async (_ctx, input) => {
        expect(input.value).toBe(secret);
        return { ok: true };
      },
    });
    const config = {
      db: database.db,
      registry,
      stepDeps: {
        executeCapability: (
          _name: string,
          ctx: Parameters<typeof executeCapability>[1],
          input: unknown,
        ) => executeCapability(capability, ctx, input),
      },
    };
    try {
      const first = createFlowEngine(config);
      const started = await first.start('carry', { value: secret }, auth, { traceparent: parent });
      const before = await database.db.execute(
        sql`SELECT traceparent, input, auth_snapshot_json FROM flow_executions`,
      );
      expect(before[0]).toMatchObject({
        traceparent: parent,
        input: { value: secret },
        auth_snapshot_json: auth,
      });
      const nextProcess = createFlowEngine(config);
      await nextProcess.runNext(
        started.id,
        createExecutionContext({
          auth,
          data: {},
          onTelemetrySpan: hook,
          audit: { record: async () => {} },
        }),
      );
      expect(seen).toHaveLength(flags === '01' ? 2 : 0);
      if (flags === '01') {
        const step = seen.find((event) => event.kind === 'worker_step');
        expect(seen.find((event) => event.kind === 'capability')?.parentSpanId).toBe(
          step?.traceparent.split('-')[2],
        );
      }
      expect(JSON.stringify(seen)).not.toContain(secret);
    } finally {
      await database.close();
    }
  });
});

describe('additive carrier migration', () => {
  it('preserves old rows and null sampling, with safe reapplication on separate planes', async () => {
    const names = ['flow_executions', 'flow_start_intents', 'event_outbox', 'job_executions'];
    for (const plane of ['spine', 'tenant']) {
      const db = await createDurableTestDatabase({
        kind: `telemetry_${plane}`,
        ddl: names
          .map(
            (name) => `CREATE TABLE "${name}" (id text PRIMARY KEY, private_data jsonb NOT NULL);`,
          )
          .join('\n'),
      });
      try {
        for (const name of names)
          await db.db.execute(
            sql.raw(`INSERT INTO "${name}" VALUES ('old', '{"private":"unchanged"}');`),
          );
        const migration = rewriteFrameworkDriftMigration(
          names.map((name) => `ALTER TABLE "${name}" ADD COLUMN "traceparent" text;`),
          { hasDrift: false, existingFrameworkTables: [], missingFrameworkTables: [], tables: [] },
        );
        for (let repeat = 0; repeat < 2; repeat++)
          for (const statement of migration.statements) await db.db.execute(sql.raw(statement));
        for (const name of names) {
          const rows = await db.db.execute(sql.raw(`SELECT * FROM "${name}"`));
          expect(rows[0]).toEqual({
            id: 'old',
            private_data: { private: 'unchanged' },
            traceparent: null,
          });
        }
      } finally {
        await db.close();
      }
    }
  });
});
