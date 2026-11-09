import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { createFlowService } from '../flow-service.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';
import { createFlowTriggerHandler } from '../triggers.js';

/**
 * In-memory regression tests for tenant isolation of event-driven resume and of
 * caller-facing ctx.flows.resume/cancel/status. PostgreSQL-backed equivalents
 * live in stabilization.integration.test.ts.
 */

const dialect = new PgDialect();

function render(where: SQL | undefined) {
  return where ? dialect.sqlToQuery(where) : { sql: '', params: [] as unknown[] };
}

/** Minimal predicate evaluator for the WHERE shapes the engine emits. */
function matches(row: Record<string, unknown>, where: SQL | undefined): boolean {
  const { sql, params } = render(where);
  const columns: Record<string, string> = {
    id: 'id',
    status: 'status',
    waiting_for_event: 'waitingForEvent',
    tenant_id: 'tenantId',
    lease_token: 'leaseToken',
  };
  for (const part of sql.split(' and ')) {
    const eqMatch = part.match(/"flow_executions"\."(\w+)" = \$(\d+)/);
    if (eqMatch) {
      const column = columns[eqMatch[1] as string];
      if (column && row[column] !== params[Number(eqMatch[2]) - 1]) return false;
      continue;
    }
    const nullMatch = part.match(/"flow_executions"\."(\w+)" is null/);
    if (nullMatch) {
      const column = columns[nullMatch[1] as string];
      if (column && row[column] != null) return false;
    }
  }
  return true;
}

function memoryDb(rows: Record<string, unknown>[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((where: SQL) => {
          const found = rows.filter((row) => matches(row, where));
          return Object.assign(Promise.resolve(found), {
            limit: (n: number) => Promise.resolve(found.slice(0, n)),
          });
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation((where: SQL) => {
          const hit = rows.filter((row) => matches(row, where));
          for (const row of hit) Object.assign(row, values);
          return Promise.resolve({ rowCount: hit.length });
        }),
      })),
    }),
  } as any;
}

function waitingRow(id: string, tenantId: string | null, actor = 'user-a') {
  return {
    id,
    flowName: 'approval',
    domain: 'orders',
    status: FlowStatus.Waiting,
    input: {},
    state: { original: id },
    currentStep: 'await',
    stepHistory: [],
    retryCount: 0,
    lastError: null,
    waitingForEvent: 'order.approved',
    wakeAt: null,
    actor,
    tenantId,
    authSnapshotJson: {
      userId: actor,
      tenantId: tenantId ?? undefined,
      roles: [],
      scopes: [],
      provider: 't',
    },
    correlationId: null,
    triggerEventId: null,
    leaseOwner: null,
    leaseToken: null,
    waitKind: 'event',
    leaseExpiresAt: null,
  };
}

function setup(
  rows: Record<string, unknown>[],
  options: {
    enforceExecutionOwnership?: boolean;
    authorizeFlowAccess?: import('../engine.js').AuthorizeFlowAccess;
  } = {},
) {
  const registry = new FlowRegistry();
  registry.register(
    defineFlow({
      name: 'approval',
      domain: 'orders',
      input: z.object({}),
      steps: [
        { name: 'await', type: FlowStepType.Wait, event: 'order.approved' },
        { name: 'ship', type: FlowStepType.Capability },
      ],
    }),
  );
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const engine = createFlowEngine({
    db: memoryDb(rows),
    registry,
    logger,
    stepDeps: { executeCapability: vi.fn(), evaluateCondition: () => true },
    ...options,
  });
  return { engine, registry, logger };
}

function envelope(tenantId?: string) {
  return {
    id: 'evt-1',
    eventType: 'order.approved',
    version: '1',
    occurredAt: new Date(),
    actor: 'user-b',
    tenantId,
    correlationId: 'corr-1',
    payload: { forged: true },
  };
}

describe('event-driven resume is tenant-scoped', () => {
  it("an event from tenant B resumes only tenant B's waiting executions", async () => {
    const rows = [waitingRow('exec-a', 'tenant-a'), waitingRow('exec-b', 'tenant-b')];
    const { engine, registry } = setup(rows);
    const handler = createFlowTriggerHandler({ registry, engine });

    expect(await handler.handleEvent(envelope('tenant-b'))).toEqual(['exec-b']);
    expect(rows[0]).toMatchObject({ status: FlowStatus.Waiting, state: { original: 'exec-a' } });
    expect(rows[1]).toMatchObject({ status: FlowStatus.Created, state: { forged: true } });
  });

  it('a tenantless event resumes only tenantless executions', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a'), waitingRow('exec-none', null)];
    const { engine, registry } = setup(rows);
    const handler = createFlowTriggerHandler({ registry, engine });

    expect(await handler.handleEvent(envelope(undefined))).toEqual(['exec-none']);
    expect(rows[0]?.status).toBe(FlowStatus.Waiting);
  });

  it('a tenant event does not resume tenantless executions', async () => {
    const rows = [waitingRow('exec-none', null)];
    const { engine, registry } = setup(rows);
    const handler = createFlowTriggerHandler({ registry, engine });

    expect(await handler.handleEvent(envelope('tenant-a'))).toEqual([]);
    expect(rows[0]?.status).toBe(FlowStatus.Waiting);
  });

  it('re-checks the tenant before resuming (row changed tenant after selection)', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const { engine } = setup(rows);
    // The selection sees tenant-a; every later read sees tenant-b.
    const row = rows[0] as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(row, 'tenantId', {
      get: () => (reads++ < 1 ? 'tenant-a' : 'tenant-b'),
      configurable: true,
    });
    const resumed = await engine.resumeWaitingByEvent(
      'order.approved',
      {},
      { tenantId: 'tenant-a' },
    );
    expect(resumed).toEqual([]);
    expect(row.status).toBe(FlowStatus.Waiting);
  });

  it('the atomic update carries the tenant predicate', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const db = memoryDb(rows);
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'approval',
        domain: 'orders',
        input: z.object({}),
        steps: [{ name: 'await', type: FlowStepType.Wait, event: 'order.approved' }],
      }),
    );
    const engine = createFlowEngine({
      db,
      registry,
      stepDeps: { executeCapability: vi.fn(), evaluateCondition: () => true },
    });
    await engine.resumeWaitingByEvent('order.approved', {}, { tenantId: 'tenant-a' });
    const setCall = db.update.mock.results[0].value.set.mock.results[0].value;
    const where = render(setCall.where.mock.calls[0][0]);
    expect(where.sql).toContain('"flow_executions"."tenant_id" = $');
    expect(where.params).toContain('tenant-a');
  });

  it('unscoped legacy calls still resume all tenants and warn once', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a'), waitingRow('exec-b', 'tenant-b')];
    const { engine, logger } = setup(rows);

    expect(await engine.resumeWaitingByEvent('order.approved')).toEqual(['exec-a', 'exec-b']);
    await engine.resumeWaitingByEvent('order.approved');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('ctx.flows resume/cancel/status authorization', () => {
  const tenantA = { userId: 'user-a', tenantId: 'tenant-a', roles: [], scopes: [], provider: 't' };
  const tenantB = { userId: 'user-b', tenantId: 'tenant-b', roles: [], scopes: [], provider: 't' };
  const otherUserA = { ...tenantA, userId: 'user-a2' };

  it('rejects a caller from another tenant with not-found on every operation', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const { engine } = setup(rows);
    const flows = createFlowService(engine, tenantB);

    await expect(flows.status('exec-a')).rejects.toThrow('Flow execution "exec-a" not found');
    await expect(flows.resume('exec-a', { forged: true })).rejects.toThrow('not found');
    await expect(flows.cancel('exec-a')).rejects.toThrow('not found');
    expect(rows[0]).toMatchObject({ status: FlowStatus.Waiting, state: { original: 'exec-a' } });
  });

  it('a foreign id answers exactly like an unknown id', async () => {
    const { engine } = setup([waitingRow('exec-a', 'tenant-a')]);
    const flows = createFlowService(engine, tenantB);
    const foreign = await flows.status('exec-a').catch((error: Error) => error.message);
    const unknown = await flows.status('exec-zzz').catch((error: Error) => error.message);
    expect(foreign).toBe(unknown.replace('exec-zzz', 'exec-a'));
  });

  it('by default limits resume/cancel/terminate/status to the starting actor', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const { engine } = setup(rows);

    expect((await createFlowService(engine, tenantA).status('exec-a')).status).toBe('waiting');
    const other = createFlowService(engine, otherUserA);
    await expect(other.status('exec-a')).rejects.toThrow('not found');
    await expect(other.resume('exec-a', { ok: true })).rejects.toThrow('not found');
    await expect(other.cancel('exec-a')).rejects.toThrow('not found');
    await expect(other.terminate('exec-a')).rejects.toThrow('not found');
    expect(rows[0]?.status).toBe(FlowStatus.Waiting);
  });

  it('enforceExecutionOwnership: false lets another actor of the tenant act, warning once', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const { engine, logger } = setup(rows, { enforceExecutionOwnership: false });

    expect((await createFlowService(engine, tenantA).status('exec-a')).status).toBe('waiting');
    expect(logger.warn).not.toHaveBeenCalled();
    const other = createFlowService(engine, otherUserA);
    await other.status('exec-a');
    await other.status('exec-a');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await other.resume('exec-a', { ok: true });
    expect(rows[0]?.status).toBe(FlowStatus.Created);
  });

  it('an execution whose owner cannot be read is not acted on', async () => {
    const { engine } = setup([]);
    await expect(createFlowService(engine, tenantA).resume('missing')).rejects.toThrow('not found');
  });

  it('enforceExecutionOwnership limits resume/cancel/status to the starting actor', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const { engine } = setup(rows, { enforceExecutionOwnership: true });
    const other = createFlowService(engine, otherUserA);

    await expect(other.status('exec-a')).rejects.toThrow('not found');
    await expect(other.resume('exec-a')).rejects.toThrow('not found');
    await expect(other.cancel('exec-a')).rejects.toThrow('not found');
    expect(rows[0]?.status).toBe(FlowStatus.Waiting);

    const owner = createFlowService(engine, tenantA);
    await owner.resume('exec-a', { ok: true });
    expect(rows[0]?.status).toBe(FlowStatus.Created);
  });

  it('system callers without a tenant (worker paths) are not restricted', async () => {
    const rows = [waitingRow('exec-a', 'tenant-a')];
    const { engine, logger } = setup(rows, { enforceExecutionOwnership: true });
    const system = {
      userId: 'system-flow-runner',
      roles: ['system'],
      scopes: [],
      provider: 'worker',
    };
    const flows = createFlowService(engine, system);

    expect((await flows.status('exec-a')).status).toBe('waiting');
    await flows.resume('exec-a');
    expect(rows[0]?.status).toBe(FlowStatus.Created);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a system-role caller bound to a tenant still cannot reach another tenant', async () => {
    const { engine } = setup([waitingRow('exec-a', 'tenant-a')]);
    const flows = createFlowService(engine, { ...tenantB, roles: ['system'] });
    await expect(flows.status('exec-a')).rejects.toThrow('not found');
  });

  describe('authorizeFlowAccess: the app decides for another actor of the same tenant', () => {
    it('asks the app with the caller, operation, flow and owner, and acts when it allows', async () => {
      const rows = [waitingRow('exec-a', 'tenant-a')];
      const authorizeFlowAccess = vi.fn().mockResolvedValue(true);
      const { engine } = setup(rows, { authorizeFlowAccess });
      const other = createFlowService(engine, otherUserA);

      expect((await other.status('exec-a')).status).toBe('waiting');
      expect(authorizeFlowAccess).toHaveBeenCalledWith({
        auth: otherUserA,
        operation: 'status',
        executionId: 'exec-a',
        flowName: 'approval',
        owner: { actor: 'user-a', tenantId: 'tenant-a', flowName: 'approval' },
      });
      await other.resume('exec-a', { ok: true });
      expect(authorizeFlowAccess).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: 'resume' }),
      );
      expect(rows[0]?.status).toBe(FlowStatus.Created);
    });

    it('accepts { allowed: true } and refuses { allowed: false } as not found', async () => {
      const rows = [waitingRow('exec-a', 'tenant-a')];
      const verdicts = [{ allowed: true }, { allowed: false, reason: 'not on this course' }];
      const { engine } = setup(rows, {
        authorizeFlowAccess: async () => verdicts.shift() ?? false,
      });
      const other = createFlowService(engine, otherUserA);
      expect((await other.status('exec-a')).status).toBe('waiting');
      await expect(other.cancel('exec-a')).rejects.toThrow('Flow execution "exec-a" not found');
      expect(rows[0]?.status).toBe(FlowStatus.Waiting);
    });

    it('fails closed when the app refuses, answers anything but true, or throws', async () => {
      const rows = [waitingRow('exec-a', 'tenant-a')];
      for (const authorizeFlowAccess of [
        async () => false,
        async () => ({ allowed: 'yes' }) as never,
        async () => {
          throw new Error('directory down');
        },
      ]) {
        const { engine } = setup(rows, { authorizeFlowAccess });
        const other = createFlowService(engine, otherUserA);
        await expect(other.status('exec-a')).rejects.toThrow('not found');
        await expect(other.terminate('exec-a')).rejects.toThrow('not found');
      }
      expect(rows[0]?.status).toBe(FlowStatus.Waiting);
    });

    it('is never asked about the starting actor, another tenant, or an untenanted system caller', async () => {
      const rows = [waitingRow('exec-a', 'tenant-a')];
      const authorizeFlowAccess = vi.fn().mockResolvedValue(true);
      const { engine } = setup(rows, { authorizeFlowAccess });

      await createFlowService(engine, tenantA).status('exec-a');
      await expect(createFlowService(engine, tenantB).status('exec-a')).rejects.toThrow(
        'not found',
      );
      await createFlowService(engine, {
        userId: 'runner',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
      }).status('exec-a');
      expect(authorizeFlowAccess).not.toHaveBeenCalled();
    });

    it('asks about a caller without a tenant (a platform operator), with the execution tenant on owner', async () => {
      const rows = [waitingRow('exec-a', 'tenant-a')];
      const authorizeFlowAccess = vi.fn().mockResolvedValue(true);
      const { engine } = setup(rows, { authorizeFlowAccess });
      const operator = { userId: 'operator-1', roles: ['admin'], scopes: [], provider: 'ops' };
      await createFlowService(engine, operator).cancel('exec-a');
      expect(authorizeFlowAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: operator,
          operation: 'cancel',
          owner: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      authorizeFlowAccess.mockResolvedValue(false);
      await expect(createFlowService(engine, operator).status('exec-a')).rejects.toThrow(
        'not found',
      );
    });

    it('with enforceExecutionOwnership: false the hook is not consulted (any actor of the tenant acts)', async () => {
      const rows = [waitingRow('exec-a', 'tenant-a')];
      const authorizeFlowAccess = vi.fn().mockResolvedValue(false);
      const { engine } = setup(rows, { enforceExecutionOwnership: false, authorizeFlowAccess });
      expect((await createFlowService(engine, otherUserA).status('exec-a')).status).toBe('waiting');
      expect(authorizeFlowAccess).not.toHaveBeenCalled();
    });
  });
});
