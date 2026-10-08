import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowConditionError } from '../../flows/evaluate-condition.js';
import { createTestContext } from '../../testing/context.js';
import { ErrorCode } from '../../types/enums.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { PlumbusConfig } from '../../types/config.js';
import {
  buildStepDeps,
  buildWorkerAiService,
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
    // Rejected before execution: nothing for the worker pool to report.
    expect(result.capability).toBeUndefined();
  });

  it('names the capability only on failures that came from executing it', async () => {
    const action = (name: string, fail: boolean): CapabilityContract =>
      ({
        name,
        kind: 'action',
        domain: 'reports',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        effects: { data: [], events: [], external: [], ai: false },
        access: { roles: ['admin'] },
        handler: async (ctx) => {
          if (fail) throw ctx.errors.conflict('Already running');
          return { ok: true };
        },
      }) as CapabilityContract;
    const registry = new CapabilityRegistry();
    registry.register(action('startReport', true));
    registry.register(action('checkReport', false));
    const stepDeps = buildStepDeps(registry);
    const ctx = createTestContext({ auth: { roles: ['admin'] } });

    const failed = await stepDeps.executeCapability('reports.startReport', ctx, {});
    expect(failed).toMatchObject({
      success: false,
      error: { code: 'conflict' },
      capability: { name: 'startReport', domain: 'reports' },
    });
    const passed = await stepDeps.executeCapability('reports.checkReport', ctx, {});
    expect(passed).toEqual({ success: true, data: { ok: true } });
    const unknown = await stepDeps.executeCapability('reports.missing', ctx, {});
    expect(unknown.success).toBe(false);
    expect(unknown.capability).toBeUndefined();
  });

  it('wires evaluateFlowCondition as evaluateCondition (C1)', () => {
    const stepDeps = buildStepDeps(new CapabilityRegistry());
    expect(stepDeps.evaluateCondition('state.amount > 100', { amount: 150 })).toBe(true);
    // Arbitrary JS is rejected — the safe evaluator is wired, not `new Function`.
    expect(() => stepDeps.evaluateCondition('process.exit(1)', {})).toThrow(FlowConditionError);
  });
});

describe('buildWorkerAiService', () => {
  const baseConfig: PlumbusConfig = {
    environment: 'development',
    database: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: '' },
    queue: { host: 'localhost', port: 6379 },
    auth: { provider: 'jwt', secret: 'synthetic-test-secret-at-least-32-characters' },
  };
  const cases: [string, Partial<PlumbusConfig>][] = [
    ['ai', { ai: { provider: 'anthropic', apiKey: 'sk-ant-test', cache: { messages: true } } }],
    [
      'aiProviders',
      {
        aiProviders: {
          defaultProvider: 'anthropic',
          providers: { anthropic: { provider: 'anthropic', apiKey: 'sk-ant-test' } },
          cache: { messages: true },
        },
      },
    ],
  ];

  it.each(cases)('applies the %s prompt-cache default to provider requests', async (_, ai) => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const service = buildWorkerAiService({ config: { ...baseConfig, ...ai }, db: {} as never });
      await service?.generate({ prompt: 'hi', input: {} });

      const body = JSON.parse(mockFetch.mock.calls[0]?.[1].body as string);
      expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
