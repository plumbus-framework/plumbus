// `plumbus flow schedule sync` must reconcile the planes the worker schedules on, picked with
// the worker's precedence (worker/bootstrap.ts): a data-plane resolver wins over schedulePlanes.

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../../define/defineFlow.js';

const state = vi.hoisted(() => ({
  flows: [] as unknown[],
  extensions: {} as Record<string, unknown>,
  connection: { db: {} },
  reconcile: vi.fn(async () => ({ revision: 'r1', changes: [], applied: false })),
  closeConnection: vi.fn(async () => undefined),
}));

vi.mock('../../../config/index.js', () => ({
  loadAppConfig: vi.fn(async () => ({ database: {} })),
}));
vi.mock('../../../data/connection.js', () => ({
  resolveDatabaseConnection: vi.fn(async () => state.connection),
  closeDatabaseConnection: state.closeConnection,
}));
vi.mock('../../../runtime/bootstrap.js', () => ({
  discoverRuntimeResources: vi.fn(async () => ({ flows: state.flows, capabilities: [] })),
  buildStepDeps: vi.fn(() => ({})),
}));
vi.mock('../../../runtime/load-extensions.js', () => ({
  loadServerExtensions: vi.fn(async () => state.extensions),
}));
vi.mock('../../../flows/scheduler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../flows/scheduler.js')>()),
  createFlowScheduler: vi.fn(() => ({ reconcileSchedules: state.reconcile })),
}));

import { registerFlowCommand } from '../flow.js';
import { createFlowScheduler } from '../../../flows/scheduler.js';

function scheduledFlow(name: string, plane?: 'spine' | 'tenants') {
  return defineFlow({
    name,
    domain: 'ops',
    input: z.object({}),
    schedule: { cron: 'every:1h', ...(plane ? { plane } : {}) },
    steps: [{ name: 'tick', type: 'capability', capability: 'ops.tick' }],
  });
}

function closableResolver() {
  return { resolve: vi.fn(), close: vi.fn(async () => undefined) };
}

async function sync(): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerFlowCommand(program);
  await program.parseAsync(['node', 'plumbus', 'flow', 'schedule', 'sync']);
}

describe('plumbus flow schedule sync plane selection', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(createFlowScheduler).mockClear();
    state.reconcile.mockClear();
    state.closeConnection.mockClear();
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('refuses when a data-plane resolver has no listTenantRefs and tenant flows are scheduled', async () => {
    const dataPlaneResolver = closableResolver();
    state.flows = [scheduledFlow('nightly', 'spine'), scheduledFlow('hourly')];
    state.extensions = { dataPlaneResolver };

    await sync();

    expect(process.exitCode).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('Export listTenantRefs'));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('(hourly)'));
    // Nothing is reconciled onto the pool in the tenant planes' place.
    expect(createFlowScheduler).not.toHaveBeenCalled();
    expect(dataPlaneResolver.close).toHaveBeenCalled();
    expect(state.closeConnection).toHaveBeenCalledWith(state.connection);
  });

  it('reconciles the spine schedules through the resolver when no tenant flow is scheduled', async () => {
    const dataPlaneResolver = closableResolver();
    state.flows = [scheduledFlow('nightly', 'spine')];
    state.extensions = { dataPlaneResolver };

    await sync();

    expect(process.exitCode).toBeUndefined();
    const config = vi.mocked(createFlowScheduler).mock.calls[0]?.[0];
    expect(config).toMatchObject({
      resolver: dataPlaneResolver,
      tenantExecutions: 'schedule-plane',
    });
    expect([...((await config?.listTenantRefs?.()) ?? [])]).toEqual([]);
    expect(state.reconcile).toHaveBeenCalledTimes(1);
  });

  it('prefers the data-plane resolver over schedulePlanes, like the worker', async () => {
    const dataPlaneResolver = closableResolver();
    const listTenantRefs = vi.fn(async () => ['tenant-a']);
    const schedulePlanes = { resolver: closableResolver(), listTenantRefs: vi.fn(async () => []) };
    state.flows = [scheduledFlow('hourly')];
    state.extensions = { dataPlaneResolver, listTenantRefs, schedulePlanes };

    await sync();

    expect(createFlowScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        resolver: dataPlaneResolver,
        listTenantRefs,
        tenantExecutions: 'schedule-plane',
      }),
    );
    expect(dataPlaneResolver.close).toHaveBeenCalled();
    expect(schedulePlanes.resolver.close).toHaveBeenCalled();
  });

  it('keeps tenant runs on the pool with schedulePlanes alone', async () => {
    const schedulePlanes = { resolver: closableResolver(), listTenantRefs: vi.fn(async () => []) };
    state.flows = [scheduledFlow('hourly')];
    state.extensions = { schedulePlanes };

    await sync();

    expect(createFlowScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        resolver: schedulePlanes.resolver,
        listTenantRefs: schedulePlanes.listTenantRefs,
        tenantExecutions: 'pool',
      }),
    );
  });

  it('stays single-plane without either export', async () => {
    state.flows = [scheduledFlow('hourly')];
    state.extensions = {};

    await sync();

    const config = vi.mocked(createFlowScheduler).mock.calls[0]?.[0];
    expect(config).not.toHaveProperty('resolver');
    expect(config).not.toHaveProperty('tenantExecutions');
  });
});
