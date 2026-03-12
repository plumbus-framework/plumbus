import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';

/**
 * Creates a mock DB that tracks inserts and updates,
 * and returns rows from a provided store.
 */
function mockDb(rows: Map<string, any> = new Map()) {
  const inserts: any[] = [];
  const updates: any[] = [];

  return {
    _inserts: inserts,
    _updates: updates,
    _rows: rows,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: any) => {
        inserts.push(row);
        rows.set(row.id, {
          ...row,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        });
        return Promise.resolve();
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            // Return the most recently queried row from the map
            const allRows = Array.from(rows.values());
            return Promise.resolve(allRows.length > 0 ? [allRows[allRows.length - 1]] : []);
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: any) => ({
        where: vi.fn().mockImplementation(() => {
          updates.push(values);
          // Apply update to last row
          const allRows = Array.from(rows.values());
          if (allRows.length > 0) {
            const last = allRows[allRows.length - 1];
            Object.assign(last, values);
          }
          return Promise.resolve();
        }),
      })),
    }),
  } as any;
}

function makeTestFlow() {
  return defineFlow({
    name: 'order-processing',
    domain: 'orders',
    input: z.object({ orderId: z.string() }),
    steps: [
      { name: 'validate', type: FlowStepType.Capability },
      { name: 'process', type: FlowStepType.Capability },
      { name: 'notify', type: FlowStepType.Capability },
    ],
  });
}

function makeAuth() {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    roles: ['admin'],
    scopes: [],
    provider: 'test',
  };
}

function makeStepDeps(succeeds = true) {
  return {
    executeCapability: vi
      .fn()
      .mockResolvedValue(
        succeeds ? { success: true, data: {} } : { success: false, error: 'step failed' },
      ),
    evaluateCondition: vi.fn().mockReturnValue(true),
  };
}

describe('FlowEngine', () => {
  it('starts a flow and creates execution record', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    const exec = await engine.start('order-processing', { orderId: '123' }, makeAuth());
    expect(exec.flowName).toBe('order-processing');
    expect(exec.status).toBe(FlowStatus.Created);
    expect(exec.id).toBeTruthy();
    expect(db._inserts).toHaveLength(1);
    expect(db._inserts[0].flowName).toBe('order-processing');
  });

  it('throws on unregistered flow', async () => {
    const registry = new FlowRegistry();
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    await expect(engine.start('nope', {}, makeAuth())).rejects.toThrow('not registered');
  });

  it('validates input against flow schema', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    await expect(engine.start('order-processing', { wrong: 123 }, makeAuth())).rejects.toThrow(
      'invalid input',
    );
  });

  it('gets flow execution status', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());

    // Mock the select to return the created row
    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    const st = await engine.status(exec.id);
    expect(st.id).toBe(exec.id);
    expect(st.flowName).toBe('order-processing');
  });

  it('cancels a created flow', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());

    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    await engine.cancel(exec.id);
    expect(db._updates.some((u: any) => u.status === FlowStatus.Cancelled)).toBe(true);
  });

  it('throws when cancelling a terminal flow', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const rows = new Map();
    rows.set('x', {
      id: 'x',
      flowName: 'order-processing',
      status: FlowStatus.Completed,
      currentStep: null,
      stepHistory: [],
      state: null,
      retryCount: 0,
    });
    const db = mockDb(rows);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rows.get('x')]),
        }),
      }),
    });
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    await expect(engine.cancel('x')).rejects.toThrow('terminal state');
  });

  it('records audit events when audit service provided', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const auditRecords: any[] = [];
    const audit = {
      record: vi.fn().mockImplementation(async (action: string, meta: any) => {
        auditRecords.push({ action, ...meta });
      }),
    };
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps(), audit });

    await engine.start('order-processing', { orderId: 'abc' }, makeAuth());
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].action).toBe('flow.started.order-processing');
  });
});
