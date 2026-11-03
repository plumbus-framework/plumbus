import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { outboxTable } from '../../events/outbox.js';
import { executeCapability } from '../../execution/capability-executor.js';
import {
  buildCapabilityRuntimeDeps,
  stripHandlerRuntime,
} from '../../execution/capability-invocation.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { createExecutionContext } from '../../execution/context-factory.js';
import { flowExecutionsTable, flowStartIntentsTable } from '../../flows/schema.js';
import { executeStep } from '../../flows/step-executor.js';
import { jobExecutionsTable } from '../../jobs/schema.js';
import type { CapabilityContract } from '../../types/capability.js';
import {
  type CompletedTelemetrySpan,
  startTelemetrySpan,
  type TelemetrySpanHook,
  validatedTraceparent,
} from '../index.js';

const parent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
const privateValue = 'PRIVATE-payload-token-email-SQL-tenant';
function cap(name: string, handler: CapabilityContract['handler']): CapabilityContract {
  return {
    name,
    domain: 'example',
    kind: 'query',
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { public: true },
    handler,
  } as CapabilityContract;
}
function context(traceparent: string | undefined, onTelemetrySpan: TelemetrySpanHook) {
  return createExecutionContext({
    auth: { userId: privateValue, tenantId: privateValue, roles: [], scopes: [], provider: 'test' },
    data: {},
    traceparent,
    onTelemetrySpan,
    audit: { record: async () => {} },
  });
}
describe('vendor-neutral telemetry boundary', () => {
  it('preserves opaque flags but rejects malformed/zero carriers and baggage', () => {
    expect(validatedTraceparent(parent)).toBe(parent);
    for (const value of [
      undefined,
      '',
      privateValue,
      parent + privateValue,
      `${parent}\n`,
      `${parent}\r`,
      `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`,
    ])
      expect(validatedTraceparent(value)).toBeUndefined();
    const hook = vi.fn();
    const unsampled = startTelemetrySpan(
      `${parent.slice(0, -2)}00`,
      'capability',
      'example.read',
      hook,
    );
    expect(unsampled.traceparent?.endsWith('-00')).toBe(true);
    unsampled.finish('error');
    expect(hook).not.toHaveBeenCalled();
  });
  it('exports an exact schema without payload/identity/error data and never waits for the hook', async () => {
    const events: CompletedTelemetrySpan[] = [];
    const hook = (span: CompletedTelemetrySpan) => {
      events.push(span);
      return new Promise<void>(() => {});
    };
    const result = await executeCapability(
      cap('read', async (ctx, input) => {
        expect(ctx.__runtime?.onTelemetrySpan).toBeUndefined();
        return { value: input.value };
      }),
      context(parent, hook),
      { value: privateValue },
    );
    expect(result).toEqual({ success: true, data: { value: privateValue } });
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      'durationMs',
      'kind',
      'name',
      'outcome',
      'parentSpanId',
      'startedAt',
      'traceparent',
    ]);
    expect(events[0]).toMatchObject({
      name: 'example.read',
      kind: 'capability',
      outcome: 'ok',
      parentSpanId: 'b'.repeat(16),
    });
    expect(JSON.stringify(events)).not.toContain(privateValue);
  });
  it('isolates throwing and rejected hooks and never exports raw exception text', async () => {
    for (const hook of [
      () => {
        throw new Error(privateValue);
      },
      async () => {
        throw new Error(privateValue);
      },
    ]) {
      const result = await executeCapability(
        cap('read', async () => {
          throw new Error(privateValue);
        }),
        context(parent, hook),
        { value: privateValue },
      );
      expect(result.success).toBe(false);
    }
    await Promise.resolve();
  });
  it('retains actual nested parentage without mixing concurrent callers', async () => {
    const events: CompletedTelemetrySpan[] = [];
    const hook = (span: CompletedTelemetrySpan) => {
      events.push(span);
    };
    const child = cap('child', async (_ctx, input) => ({ value: input.value }));
    const outer = cap(
      'outer',
      async (ctx) => await ctx.capabilities.invoke('example.child', { value: privateValue }),
    );
    outer.effects.capabilities = ['example.child'];
    const registry = new CapabilityRegistry();
    registry.register(outer);
    registry.register(child);
    await Promise.all(
      ['a', 'd'].map(async (id) => {
        const base = context(`00-${id.repeat(32)}-${'b'.repeat(16)}-01`, hook);
        await executeCapability(
          outer,
          { ...base, __runtime: { ...base.__runtime, ...buildCapabilityRuntimeDeps(registry) } },
          { value: privateValue },
        );
      }),
    );
    for (const id of ['a', 'd']) {
      const group = events.filter((event) => event.traceparent.split('-')[1] === id.repeat(32));
      expect(group).toHaveLength(2);
      expect(group.find((event) => event.name === 'example.child')?.parentSpanId).toBe(
        group.find((event) => event.name === 'example.outer')?.traceparent.split('-')[2],
      );
    }
    expect(JSON.stringify(events)).not.toContain(privateValue);
  });
  it('keeps legacy worker execution unsampled and exports a real sampled step without input/state', async () => {
    const hook = vi.fn();
    const deps = { executeCapability: async () => ({ success: true as const, data: {} }) };
    for (const carrier of [undefined, `${parent.slice(0, -2)}00`]) {
      await executeStep(
        { name: 'pause', type: 'delay', duration: '1s' },
        context(carrier, hook),
        { secret: privateValue },
        { secret: privateValue },
        deps,
      );
    }
    expect(hook).not.toHaveBeenCalled();
    await executeStep(
      { name: 'pause', type: 'delay', duration: '1s' },
      context(parent, hook),
      privateValue,
      privateValue,
      deps,
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(JSON.stringify(hook.mock.calls)).not.toContain(privateValue);
  });
  it('places nullable carrier columns beside metadata, never inside payload/auth snapshots', () => {
    for (const table of [
      flowExecutionsTable,
      flowStartIntentsTable,
      jobExecutionsTable,
      outboxTable,
    ]) {
      const column = getTableColumns(table).traceparent;
      expect(column?.name).toBe('traceparent');
      expect(column?.notNull).toBe(false);
    }
  });
});

it('hides the host callback even from the privileged confirmation runtime adapter', () => {
  const hook = vi.fn();
  const invokeCapability = vi.fn();
  const visible = stripHandlerRuntime(
    { onTelemetrySpan: hook, invokeCapability },
    { preserveCapabilityRuntime: true },
  );
  expect(visible?.onTelemetrySpan).toBeUndefined();
  expect(visible?.invokeCapability).toBe(invokeCapability);
});
