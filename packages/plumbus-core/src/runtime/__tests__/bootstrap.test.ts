import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { createTestContext } from '../../testing/context.js';
import { ErrorCode } from '../../types/enums.js';
import type { CapabilityContract } from '../../types/capability.js';
import {
  buildStepDeps,
  needsJobQueuePublish,
  needsWorkerPool,
  resolveRuntimeRole,
  shouldStartApiServer,
  shouldStartWorkerPool,
} from '../bootstrap.js';

describe('resolveRuntimeRole', () => {
  it('defaults dev and start to all', () => {
    expect(resolveRuntimeRole('dev', {})).toBe('all');
    expect(resolveRuntimeRole('start', {})).toBe('all');
  });

  it('defaults worker command to worker', () => {
    expect(resolveRuntimeRole('worker', {})).toBe('worker');
  });

  it('respects PLUMBUS_RUNTIME_ROLE', () => {
    expect(resolveRuntimeRole('start', { PLUMBUS_RUNTIME_ROLE: 'api' })).toBe('api');
    expect(resolveRuntimeRole('worker', { PLUMBUS_RUNTIME_ROLE: 'all' })).toBe('all');
  });
});

describe('shouldStartWorkerPool / shouldStartApiServer', () => {
  it('api role skips workers but keeps API', () => {
    expect(shouldStartWorkerPool('api')).toBe(false);
    expect(shouldStartApiServer('api')).toBe(true);
  });

  it('worker role skips API', () => {
    expect(shouldStartApiServer('worker')).toBe(false);
    expect(shouldStartWorkerPool('worker')).toBe(true);
  });
});

describe('needsWorkerPool', () => {
  it('returns true when job capabilities exist', () => {
    expect(
      needsWorkerPool({
        capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(true);
  });

  it('returns false for empty resources', () => {
    expect(
      needsWorkerPool({
        capabilities: [],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(false);
  });
});

describe('needsJobQueuePublish', () => {
  it('returns true when job capabilities exist', () => {
    expect(
      needsJobQueuePublish({
        capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(true);
  });

  it('returns false without job capabilities', () => {
    expect(
      needsJobQueuePublish({
        capabilities: [{ kind: 'action', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(false);
  });
});

describe('buildStepDeps', () => {
  it('rejects job capabilities synchronously in flow steps', async () => {
    const job: CapabilityContract = {
      name: 'generateReport',
      kind: 'job',
      domain: 'reports',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { roles: ['admin'] },
      handler: async () => ({ ok: true }),
    } as CapabilityContract;

    const registry = new CapabilityRegistry();
    registry.register(job);
    const stepDeps = buildStepDeps(registry);
    const ctx = createTestContext({ auth: { roles: ['admin'] } });

    const result = await stepDeps.executeCapability('reports.generateReport', ctx, {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.DependencyViolation);
    expect((result.error.metadata as { reason?: string }).reason).toBe('unsupportedTargetKind');
  });
});
