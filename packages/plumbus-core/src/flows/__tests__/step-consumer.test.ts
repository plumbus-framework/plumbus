import { describe, expect, it, vi } from 'vitest';
import { createInMemoryQueue } from '../../events/queue.js';
import { flowStepEventType } from '../flow-queue.js';
import { createFlowStepConsumer } from '../step-consumer.js';
import { FlowStatus } from '../state-machine.js';

describe('createFlowStepConsumer', () => {
  it('calls claimExecution before runNext', async () => {
    const executionId = 'exec-123';
    const claimExecution = vi
      .fn()
      .mockResolvedValue({ id: executionId, flowName: 'f', status: 'running' });
    const runNext = vi
      .fn()
      .mockResolvedValue({ id: executionId, flowName: 'f', status: FlowStatus.Completed });
    const engine = {
      claimExecution,
      runNext,
      markFailedFromRunner: vi.fn(),
    } as never;

    const queue = createInMemoryQueue();
    const consumer = createFlowStepConsumer({
      flowsQueue: queue,
      engine,
      buildContext: () =>
        ({
          auth: { userId: 'system', roles: [], scopes: [], provider: 'test' },
        }) as never,
    });

    consumer.start();
    await queue.publish({
      id: 'wake-1',
      eventType: flowStepEventType(executionId),
      version: '1',
      occurredAt: new Date(),
      actor: 'system',
      correlationId: executionId,
      payload: { executionId },
    });

    await new Promise((r) => setTimeout(r, 50));
    await queue.close();

    expect(claimExecution).toHaveBeenCalledWith(executionId);
    expect(runNext).toHaveBeenCalled();
  });

  it('does not runNext when claimExecution returns undefined', async () => {
    const executionId = 'exec-locked';
    const claimExecution = vi.fn().mockResolvedValue(undefined);
    const runNext = vi.fn();
    const engine = {
      claimExecution,
      runNext,
      markFailedFromRunner: vi.fn(),
    } as never;

    const queue = createInMemoryQueue();
    const consumer = createFlowStepConsumer({
      flowsQueue: queue,
      engine,
      buildContext: () =>
        ({
          auth: { userId: 'system', roles: [], scopes: [], provider: 'test' },
        }) as never,
    });

    consumer.start();
    await queue.publish({
      id: 'wake-2',
      eventType: flowStepEventType(executionId),
      version: '1',
      occurredAt: new Date(),
      actor: 'system',
      correlationId: executionId,
      payload: { executionId },
    });

    await new Promise((r) => setTimeout(r, 50));
    await queue.close();

    expect(claimExecution).toHaveBeenCalledWith(executionId);
    expect(runNext).not.toHaveBeenCalled();
  });
});
