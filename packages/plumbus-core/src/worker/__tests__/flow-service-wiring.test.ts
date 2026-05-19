// Regression: the worker's flow-cycle baseCtx must carry a real FlowService.
//
// Before this was wired, `createExecutionContext({...})` fell through to
// `noopFlows` for the `flows` field, so any capability running inside a flow
// step (i.e. inside the worker) that called `ctx.flows.start(...)` got back
// `{id:'',status:'not_started'}` and the nested flow never actually launched.
//
// We saw this in production as a `requestTimelineRebuild` step that recorded
// "step completed" successfully but left its `WorkflowStepLog` stuck in
// `queued:reset` with no executionId — because the nested
// `processTimelineRebuild` flow never started.

import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from '../../execution/context-factory.js';
import { createFlowService } from '../../flows/flow-service.js';
import type { AuthContext } from '../../types/security.js';

describe('worker baseCtx — flows wiring (regression)', () => {
  it('routes ctx.flows.start to the engine instead of falling back to noopFlows', async () => {
    const engineStart = vi.fn(async (flowName: string) => ({
      id: 'exec-real-1',
      flowName,
      status: 'created' as const,
    }));
    const engine = {
      start: engineStart,
      resume: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ id: '', flowName: '', status: 'unknown' })),
    } as unknown as Parameters<typeof createFlowService>[0];

    const systemAuth: AuthContext = {
      userId: 'system-flow-runner',
      tenantId: 't-1',
      roles: ['system'],
      scopes: [],
      provider: 'worker',
    };

    const ctx = createExecutionContext({
      auth: systemAuth,
      data: {} as never,
      flows: createFlowService(engine, systemAuth),
    });

    const result = await ctx.flows.start('processTimelineRebuild', { foo: 'bar' });

    expect(engineStart).toHaveBeenCalledWith(
      'processTimelineRebuild',
      { foo: 'bar' },
      systemAuth,
    );
    expect(result.id).toBe('exec-real-1');
    expect(result.status).toBe('created');
  });

  it('without flow wiring, ctx.flows.start silently no-ops (the bug we are guarding against)', async () => {
    const ctx = createExecutionContext({
      auth: {
        userId: 'system-flow-runner',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
      },
      data: {} as never,
      // flows intentionally omitted — falls through to noopFlows
    });

    const result = await ctx.flows.start('anything', {});

    // noopFlows.start returns {id:'', status:'not_started'}. Capabilities that
    // depend on a real executionId then write empty-string executionIds into
    // their bookkeeping, leaving downstream nested flows un-launched.
    expect(result.id).toBe('');
    expect(result.status).toBe('not_started');
  });
});
