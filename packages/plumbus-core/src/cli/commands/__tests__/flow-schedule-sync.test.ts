import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../../define/defineFlow.js';

// Drives `plumbus flow schedule sync` through Commander, with config, database,
// discovery and the scheduler mocked: covers flag parsing and wiring end to end.

const mocks = vi.hoisted(() => ({
  connection: { db: { fake: 'db' } },
  closeDatabaseConnection: vi.fn(async () => {}),
  discoverRuntimeResources: vi.fn(),
  reconcileSchedules: vi.fn(),
  createFlowScheduler: vi.fn(),
}));

vi.mock('../../../config/index.js', () => ({
  loadAppConfig: vi.fn(async () => ({ database: { url: 'postgres://fake' } })),
}));

vi.mock('../../../data/connection.js', () => ({
  resolveDatabaseConnection: vi.fn(async () => mocks.connection),
  closeDatabaseConnection: mocks.closeDatabaseConnection,
}));

vi.mock('../../../runtime/bootstrap.js', () => ({
  discoverRuntimeResources: mocks.discoverRuntimeResources,
  buildStepDeps: vi.fn(() => ({})),
}));

vi.mock('../../../flows/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../flows/index.js')>();
  return {
    ...actual,
    createFlowEngine: vi.fn(() => ({ fake: 'engine' })),
    createFlowScheduler: mocks.createFlowScheduler,
  };
});

const { registerFlowCommand } = await import('../flow.js');

const nightly = defineFlow({
  name: 'nightly',
  domain: 'maintenance',
  input: z.object({}),
  schedule: { cron: 'every:1h' },
  steps: [{ name: 'step', type: 'capability', capability: 'maintenance.run' }],
});

function program() {
  const cli = new Command();
  cli.exitOverride();
  registerFlowCommand(cli);
  return cli;
}

function sync(...args: string[]) {
  return program().parseAsync(['node', 'plumbus', 'flow', 'schedule', 'sync', ...args]);
}

describe('plumbus flow schedule sync', () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverRuntimeResources.mockResolvedValue({ flows: [nightly], capabilities: [] });
    mocks.reconcileSchedules.mockResolvedValue({ revision: 'r1', changes: [], applied: false });
    mocks.createFlowScheduler.mockImplementation(() => ({
      reconcileSchedules: mocks.reconcileSchedules,
    }));
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('passes --apply, --expected-revision and --allow-remove names to the scheduler', async () => {
    await sync('--apply', '--expected-revision', 'r1', '--allow-remove', 'old, older');
    expect(mocks.reconcileSchedules).toHaveBeenCalledWith({
      apply: true,
      expectedRevision: 'r1',
      allowRemove: ['old', 'older'],
    });
  });

  it("passes --allow-remove '*' as approval for any removal", async () => {
    await sync('--apply', '--expected-revision', 'r1', '--allow-remove', '*');
    expect(mocks.reconcileSchedules).toHaveBeenCalledWith(
      expect.objectContaining({ allowRemove: true }),
    );
  });

  it('previews without approval when no flags are given', async () => {
    await sync();
    expect(mocks.reconcileSchedules).toHaveBeenCalledWith({
      apply: undefined,
      expectedRevision: undefined,
      allowRemove: undefined,
    });
  });

  it('discovers flows strictly and builds the scheduler from them on the app database', async () => {
    await sync();
    expect(mocks.discoverRuntimeResources).toHaveBeenCalledWith({ strict: ['flows'] });
    const config = mocks.createFlowScheduler.mock.calls[0]?.[0];
    expect(config.db).toBe(mocks.connection.db);
    expect(config.registry.get('nightly')).toBe(nightly);
    expect(mocks.closeDatabaseConnection).toHaveBeenCalledWith(mocks.connection);
  });

  it('prints the JSON result on stdout and removals on stderr', async () => {
    const result = {
      revision: 'r1',
      changes: [{ flowName: 'old', action: 'remove' }],
      applied: true,
    };
    mocks.reconcileSchedules.mockResolvedValueOnce(result);
    await sync('--apply', '--expected-revision', 'r1', '--allow-remove', 'old');
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(result);
    expect(stderr).toHaveBeenCalledWith('⚠ Removed schedule: old');
  });

  it('closes the connection and skips reconciliation when a flow module fails to load', async () => {
    mocks.discoverRuntimeResources.mockRejectedValueOnce(
      new Error('Unable to load flow module: broken.ts'),
    );
    await expect(sync('--apply', '--expected-revision', 'r1')).rejects.toThrow('broken.ts');
    expect(mocks.reconcileSchedules).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(mocks.closeDatabaseConnection).toHaveBeenCalledWith(mocks.connection);
  });

  it('closes the connection when the scheduler refuses the apply', async () => {
    mocks.reconcileSchedules.mockRejectedValueOnce(new Error('would remove old'));
    await expect(sync('--apply', '--expected-revision', 'r1')).rejects.toThrow('would remove old');
    expect(mocks.closeDatabaseConnection).toHaveBeenCalledWith(mocks.connection);
  });
});
