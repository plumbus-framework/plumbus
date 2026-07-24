import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { FlowRegistry } from '../registry.js';
import { createFlowService } from '../flow-service.js';

describe('FlowService', () => {
  function mockEngine() {
    return {
      start: vi.fn().mockResolvedValue({ id: 'exec-1', flowName: 'test-flow', status: 'created' }),
      resume: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({ id: 'exec-1', flowName: 'test-flow', status: 'running' }),
      runNext: vi.fn(),
    };
  }

  const auth = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    roles: ['admin'],
    scopes: [],
    provider: 'test',
  };

  it('start() delegates to engine with bound auth', async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    const result = await svc.start('test-flow', { data: 1 });
    expect(result.id).toBe('exec-1');
    expect(engine.start).toHaveBeenCalledWith('test-flow', { data: 1 }, auth, undefined);
  });

  it('resume() delegates to engine', async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    await svc.resume('exec-1', { signal: 'approved' });
    expect(engine.resume).toHaveBeenCalledWith('exec-1', { signal: 'approved' });
  });

  it('cancel() delegates to engine', async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    await svc.cancel('exec-1');
    expect(engine.cancel).toHaveBeenCalledWith('exec-1');
  });

  it('status() delegates to engine', async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    const st = await svc.status('exec-1');
    expect(st.status).toBe('running');
    expect(engine.status).toHaveBeenCalledWith('exec-1');
  });

  it('heartbeat() is a no-op outside flow execution', async () => {
    // The real heartbeat is injected onto flowCtx.flows.heartbeat by the engine during runNext.
    // Calling it on a detached service (e.g. from a capability or API handler) must resolve silently
    // rather than touch the db or throw — otherwise consumer code can't portably call ctx.flows.heartbeat().
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    await expect(svc.heartbeat()).resolves.toBeUndefined();
  });

  it('describe() returns undefined when no registry is supplied', () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);
    expect(svc.describe?.('x')).toBeUndefined();
  });

  it('describe() returns undefined for an unregistered flow', () => {
    const engine = mockEngine();
    const registry = new FlowRegistry();
    const svc = createFlowService(engine as any, auth, registry);
    expect(svc.describe?.('missing')).toBeUndefined();
  });

  it('describe() returns name/domain/inputSchema/parameters for a registered flow', () => {
    const engine = mockEngine();
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'demo-flow',
        domain: 'test',
        description: 'A demo flow',
        input: z.object({ q: z.string().optional() }),
        steps: [{ type: 'capability', name: 'stepA' }],
      }),
    );
    const svc = createFlowService(engine as any, auth, registry);
    const desc = svc.describe?.('demo-flow');
    expect(desc).toBeDefined();
    expect(desc?.name).toBe('demo-flow');
    expect(desc?.domain).toBe('test');
    expect(desc?.inputSchema).toBeDefined();
    expect(desc?.parameters).toBeDefined();
    expect(typeof desc?.parameters).toBe('object');
  });

  it('describe() degrades parameters to undefined on ProviderJsonSchemaError', () => {
    const engine = mockEngine();
    const registry = new FlowRegistry();
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let index = 0; index < 25; index += 1) {
      shape[`field${index}`] = z.string().optional();
    }
    registry.register(
      defineFlow({
        name: 'too-many-optionals',
        domain: 'test',
        input: z.object(shape),
        steps: [{ type: 'capability', name: 'stepA' }],
      }),
    );
    const svc = createFlowService(engine as any, auth, registry);
    const desc = svc.describe?.('too-many-optionals');
    expect(desc?.inputSchema).toBeDefined();
    expect(desc?.parameters).toBeUndefined();
  });
});
