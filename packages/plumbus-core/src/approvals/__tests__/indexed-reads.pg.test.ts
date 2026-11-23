// The approval service reads `approval_request` by index, never the whole table: every
// request, gate check and lookup is scoped to its tenant + execution (and capability /
// binding / live state), expiry is one UPDATE, and the paged list walks the primary key.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../data/migration.js';
import { FRAMEWORK_SCHEMA } from '../../data/schema-generator.js';
import { createDurableTestDatabase, resolveTestPostgresAdmin } from '../../durable/index.js';
import { FRAMEWORK_DURABLE_TENANT_MIGRATIONS } from '../../durable/migrations-path.js';
import { ActionRiskTier, ReviewMandateReason } from '../action-risk.js';
import { createAllowAllAuthorizationProvider } from '../authorization.js';
import { digestApprovalInput } from '../digest.js';
import { createApprovalService } from '../service.js';
import { createSqlApprovalStore } from '../sql-store.js';
import {
  type ApprovalRequestRecord,
  ApprovalRequestState,
  type ApprovalStore,
  HUMAN_TASK_CONTRACT_VERSION,
} from '../types.js';

const admin = resolveTestPostgresAdmin();
const closers: Array<() => Promise<void>> = [];
let databaseName = '';
let plain: postgres.Sql;
/** Every statement the store sent, in order. */
const statements: string[] = [];
let db: PostgresJsDatabase;

/** Rows seeded before each scenario: history the old service read in full on every call. */
const HISTORY_EXECUTIONS = 400;

beforeAll(async () => {
  const tenant = await createDurableTestDatabase({ admin, kind: 'apprix', ddl: '' });
  closers.push(tenant.close);
  databaseName = tenant.name;
  await applyMigrations({ db: tenant.db, migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS });
  plain = postgres({
    host: admin.host,
    port: admin.port,
    database: databaseName,
    username: admin.user,
    password: admin.password,
    max: 2,
    onnotice: () => {},
  });
  closers.push(() => plain.end({ timeout: 5 }));
  db = drizzle(plain, { logger: { logQuery: (query) => statements.push(query) } });

  // Settled history from other executions: 5 rows per execution, 2,000 rows in all.
  await plain.unsafe(`
    INSERT INTO core_plumbus.approval_request (
      approval_request_id, capability_id, definition_version, input_digest, risk_class,
      review_reason, state, tenant_id, execution_id, created_at, expires_at, updated_at,
      resolved_at
    )
    SELECT 'hist-' || e || '-' || k, 'feedback.publish', '1', 'digest-' || e, 'consequential',
      'risk-tier', CASE WHEN k = 0 THEN 'approved' ELSE 'invalidated' END, 'tenant-1',
      'exec-' || e, now() - interval '1 day', now() + interval '1 day',
      now() - interval '1 day', now() - interval '1 day'
    FROM generate_series(1, ${HISTORY_EXECUTIONS}) e, generate_series(0, 4) k
  `);
  await plain.unsafe('ANALYZE core_plumbus.approval_request');
}, 60_000);

afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

/** Counts `listRequests` calls so a test can prove the service never made one. */
function countingStore(): { store: ApprovalStore; fullReads: () => number } {
  const inner = createSqlApprovalStore({ db, schemaName: FRAMEWORK_SCHEMA });
  let fullReads = 0;
  return {
    store: {
      ...inner,
      async listRequests() {
        fullReads += 1;
        return inner.listRequests();
      },
    },
    fullReads: () => fullReads,
  };
}

function approvalStatements(since: number): string[] {
  return statements.slice(since).filter((query) => query.includes('"approval_request"'));
}

function isUnfilteredSelect(query: string): boolean {
  return /^select\b/i.test(query) && !/\bwhere\b/i.test(query);
}

describe('approval service on the SQL store', () => {
  it('requests, invalidates and checks approvals without reading the whole table', async () => {
    const { store, fullReads } = countingStore();
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
    const since = statements.length;

    const first = await service.requestApproval({
      tenantId: 'tenant-1',
      executionId: 'exec-new',
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      input: { revision: 'r1' },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // A changed input for the same subject invalidates the live request.
    const second = await service.requestApproval({
      tenantId: 'tenant-1',
      executionId: 'exec-new',
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      input: { revision: 'r2' },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await store.getRequest(first.approvalRequestId))?.state).toBe('invalidated');
    await service.decide({
      requestId: second.approvalRequestId,
      outcome: 'approved',
      auth: { userId: 'approver-1', roles: [], scopes: [], provider: 'oidc' },
    });

    const binding = {
      tenantId: 'tenant-1',
      executionId: 'exec-new',
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      inputDigest: digestApprovalInput({ revision: 'r2' }),
    };
    expect((await service.findMatchingApproval(binding))?.approvalRequestId).toBe(
      second.approvalRequestId,
    );
    expect(
      await service.findConflictingApproval({
        ...binding,
        inputDigest: digestApprovalInput({ revision: 'r1' }),
      }),
    ).toMatchObject({ approvalRequestId: second.approvalRequestId });
    expect(
      (await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'exec-new' }))
        ?.approvalRequestId,
    ).toBe(second.approvalRequestId);
    expect(await service.invalidateOnMaterialChange(binding)).toEqual([]);

    expect(fullReads()).toBe(0);
    const sent = approvalStatements(since);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter(isUnfilteredSelect)).toEqual([]);
  });

  it('keeps tenants and executions apart, and null only matches rows stored without one', async () => {
    const store = createSqlApprovalStore({ db, schemaName: FRAMEWORK_SCHEMA });
    const base = {
      contractVersion: HUMAN_TASK_CONTRACT_VERSION,
      capabilityId: 'scope.check',
      definitionVersion: '1',
      inputDigest: 'd',
      riskClass: ActionRiskTier.Consequential,
      reviewReason: ReviewMandateReason.RiskTier,
      state: ApprovalRequestState.Pending,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } satisfies Partial<ApprovalRequestRecord>;
    await store.putRequest({ ...base, approvalRequestId: 'scope-a', tenantId: 't-a' });
    await store.putRequest({
      ...base,
      approvalRequestId: 'scope-a-exec',
      tenantId: 't-a',
      executionId: 'e-1',
    });
    await store.putRequest({ ...base, approvalRequestId: 'scope-b', tenantId: 't-b' });
    await store.putRequest({ ...base, approvalRequestId: 'scope-none', tenantId: null });

    const ids = async (query: Parameters<NonNullable<ApprovalStore['findRequests']>>[0]) =>
      (await store.findRequests?.(query))?.map((row) => row.approvalRequestId).sort();
    expect(await ids({ capabilityId: 'scope.check', tenantId: 't-a', executionId: null })).toEqual([
      'scope-a',
    ]);
    expect(await ids({ capabilityId: 'scope.check', tenantId: 't-a' })).toEqual([
      'scope-a',
      'scope-a-exec',
    ]);
    expect(await ids({ capabilityId: 'scope.check', tenantId: null })).toEqual(['scope-none']);
    expect(await ids({ capabilityId: 'scope.check', states: [] })).toEqual([]);
    expect(
      await ids({ capabilityId: 'scope.check', states: [ApprovalRequestState.Approved] }),
    ).toEqual([]);
    await expect(store.findRequests?.({ capabilityId: 'scope.check', limit: 0 })).rejects.toThrow(
      'limit must be a whole number from 1 to 1000',
    );
    await expect(
      store.findRequests?.({ states: ['pending; drop table x' as ApprovalRequestState] }),
    ).rejects.toThrow('Unknown approval request state');
  });

  it('expires every due approval of a lookup in one UPDATE', async () => {
    const store = createSqlApprovalStore({ db, schemaName: FRAMEWORK_SCHEMA });
    let now = new Date('2026-06-01T00:00:00.000Z');
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
      now: () => now,
    });
    const binding = {
      tenantId: 'tenant-1',
      executionId: 'exec-expiry',
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      inputDigest: 'same',
    };
    for (const id of ['due-1', 'due-2', 'due-3']) {
      await store.putRequest({
        contractVersion: HUMAN_TASK_CONTRACT_VERSION,
        approvalRequestId: id,
        capabilityId: binding.capabilityId,
        definitionVersion: binding.definitionVersion,
        inputDigest: binding.inputDigest,
        riskClass: ActionRiskTier.Consequential,
        reviewReason: ReviewMandateReason.RiskTier,
        state: ApprovalRequestState.Approved,
        tenantId: binding.tenantId,
        executionId: binding.executionId,
        createdAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        resolvedAt: '2026-05-02T00:00:00.000Z',
      });
    }
    now = new Date('2026-06-01T00:00:00.000Z');
    const since = statements.length;

    const found = await service.findMatchingApproval(binding);

    expect(found?.state).toBe('expired');
    const updates = approvalStatements(since).filter((query) => /^update\b/i.test(query));
    expect(updates).toHaveLength(1);
    // drizzle sets this client to return timestamps as text.
    const stored = await plain<Array<{ state: string; resolved_at: string }>>`
      SELECT state, resolved_at FROM core_plumbus.approval_request
      WHERE approval_request_id IN ('due-1', 'due-2', 'due-3')
    `;
    expect(stored.map((row) => row.state)).toEqual(['expired', 'expired', 'expired']);
    // An approval's resolution time is kept; expiry does not overwrite it.
    expect(stored.map((row) => new Date(row.resolved_at).toISOString())).toEqual(
      Array(3).fill('2026-05-02T00:00:00.000Z'),
    );
    // Nothing left to expire: the next lookup sends no UPDATE.
    const again = statements.length;
    await service.findMatchingApproval(binding);
    expect(approvalStatements(again).filter((query) => /^update\b/i.test(query))).toEqual([]);
  });

  it('the live-state read can use the partial index', async () => {
    const store = createSqlApprovalStore({ db, schemaName: FRAMEWORK_SCHEMA });
    const since = statements.length;
    await store.findRequests?.({
      tenantId: 'tenant-1',
      executionId: 'exec-7',
      capabilityId: 'feedback.publish',
      states: [ApprovalRequestState.Pending, ApprovalRequestState.Approved],
    });
    const [query] = approvalStatements(since);
    expect(query).toContain(`IN ('pending', 'approved')`);
    const reserved = await plain.reserve();
    try {
      await reserved.unsafe('SET enable_seqscan = off');
      const plan = (await reserved.unsafe(`EXPLAIN ${query}`, [
        'tenant-1',
        'exec-7',
        'feedback.publish',
      ])) as Array<{ 'QUERY PLAN': string }>;
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'approval_request_live_idx',
      );
    } finally {
      await reserved.unsafe('RESET enable_seqscan');
      reserved.release();
    }
  });

  it('reads many requests by id in one statement with one array parameter', async () => {
    const store = createSqlApprovalStore({ db, schemaName: FRAMEWORK_SCHEMA });
    const wanted = ['hist-1-0', 'hist-2-3', 'hist-400-4', 'no-such-request', 'hist-1-0'];
    const filler = Array.from({ length: 70_000 }, (_, i) => `missing-${i}`);
    const since = statements.length;
    const rows = await store.getRequests?.([...wanted, ...filler]);
    expect(rows?.map((row) => row.approvalRequestId).sort()).toEqual([
      'hist-1-0',
      'hist-2-3',
      'hist-400-4',
    ]);
    const sent = approvalStatements(since);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/= ANY\(\$1::text\[\]\)/);
    expect(await store.getRequests?.([])).toEqual([]);
  });

  it('pages through every request on the primary key', async () => {
    const store = createSqlApprovalStore({ db, schemaName: FRAMEWORK_SCHEMA });
    const total = (
      await plain<
        Array<{ n: number }>
      >`SELECT count(*)::int AS n FROM core_plumbus.approval_request`
    )[0]?.n;
    const seen = new Set<string>();
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await store.listAllRequests?.({ limit: 333, ...(after ? { after } : {}) });
      if (!page) throw new Error('listAllRequests missing');
      for (const row of page.requests) seen.add(row.approvalRequestId);
      expect(page.requests.length).toBeLessThanOrEqual(333);
      after = page.next;
      pages += 1;
    } while (after !== undefined);
    expect(seen.size).toBe(total);
    expect(pages).toBe(Math.ceil((total ?? 0) / 333));
    await expect(store.listAllRequests?.({ limit: 1001 })).rejects.toThrow(
      'limit must be a whole number from 1 to 1000',
    );
  });
});
