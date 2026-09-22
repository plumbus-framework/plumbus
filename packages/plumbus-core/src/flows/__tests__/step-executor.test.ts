import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../types/context.js';
import { FlowStepType } from '../../types/enums.js';
import type {
  CapabilityStep,
  ConditionalStep,
  DelayStep,
  EventEmitStep,
  ParallelStep,
  WaitStep,
} from '../../types/flow.js';
import { StepStatus } from '../state-machine.js';
import { buildHistoryEntry, executeStep, type StepExecutorDeps } from '../step-executor.js';

const mockCtx = {
  events: {
    emit: vi.fn().mockResolvedValue(undefined),
    emitMany: vi.fn().mockResolvedValue(undefined),
  },
} as unknown as ExecutionContext;

const defaultDeps: StepExecutorDeps = {
  executeCapability: vi.fn().mockResolvedValue({ success: true, data: {} }),
  evaluateCondition: vi.fn().mockReturnValue(true),
};

describe('StepExecutor', () => {
  it('executes a capability step successfully', async () => {
    const step: CapabilityStep = { name: 'processOrder', type: FlowStepType.Capability };
    const result = await executeStep(step, mockCtx, {}, {}, defaultDeps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.data).toEqual({});
    expect(defaultDeps.executeCapability).toHaveBeenCalledWith('processOrder', mockCtx, {});
  });

  it('returns failed status when capability fails', async () => {
    const step: CapabilityStep = { name: 'badCap', type: FlowStepType.Capability };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockResolvedValue({ success: false, error: 'oops' }),
    };
    const result = await executeStep(step, mockCtx, {}, {}, deps);
    expect(result.status).toBe(StepStatus.Failed);
    expect(result.error).toContain('oops');
  });

  it('returns failed status when capability throws', async () => {
    const step: CapabilityStep = { name: 'throwCap', type: FlowStepType.Capability };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const result = await executeStep(step, mockCtx, {}, {}, deps);
    expect(result.status).toBe(StepStatus.Failed);
    expect(result.error).toBe('boom');
  });

  it('merges flowInput and state into capability input', async () => {
    const step: CapabilityStep = { name: 'process', type: FlowStepType.Capability };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockResolvedValue({ success: true, data: {} }),
    };
    await executeStep(
      step,
      mockCtx,
      { projectId: 'p1', messageId: 'm1' },
      { metadataId: 'md1' },
      deps,
    );
    expect(deps.executeCapability).toHaveBeenCalledWith('process', mockCtx, {
      projectId: 'p1',
      messageId: 'm1',
      metadataId: 'md1',
    });
  });

  it('resolves $input and $state template references in step.input', async () => {
    const step: CapabilityStep = {
      name: 'extract',
      type: FlowStepType.Capability,
      input: {
        sourceType: 'interview_message',
        sourceReferenceId: '$input.messageId',
        cached: '$state.metadataId',
      },
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockResolvedValue({ success: true, data: {} }),
    };
    await executeStep(
      step,
      mockCtx,
      { projectId: 'p1', messageId: 'm1' },
      { metadataId: 'md1' },
      deps,
    );
    expect(deps.executeCapability).toHaveBeenCalledWith('extract', mockCtx, {
      sourceType: 'interview_message',
      sourceReferenceId: 'm1',
      cached: 'md1',
    });
  });

  it('keeps large state fields out of capability input when step.input narrows to a ref', async () => {
    const largeBody = 'x'.repeat(100_000);
    const step: CapabilityStep = {
      name: 'analyzeDocument',
      type: FlowStepType.Capability,
      capability: 'docs.analyzeDocument',
      input: { documentId: '$state.documentId' },
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockResolvedValue({ success: true, data: {} }),
    };
    await executeStep(step, mockCtx, {}, { documentId: 'doc-1', body: largeBody }, deps);
    expect(deps.executeCapability).toHaveBeenCalledWith('docs.analyzeDocument', mockCtx, {
      documentId: 'doc-1',
    });
  });

  it('only the reference enters the state merge when a step returns an id', async () => {
    const step: CapabilityStep = {
      name: 'storeDocument',
      type: FlowStepType.Capability,
      capability: 'docs.storeDocument',
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockResolvedValue({
        success: true,
        data: { documentId: 'doc-1' },
      }),
    };
    const result = await executeStep(step, mockCtx, {}, {}, deps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.data).toEqual({ documentId: 'doc-1' });
    expect(result.data).not.toHaveProperty('body');
  });

  it('uses step.capability instead of step.name when provided', async () => {
    const step: CapabilityStep = {
      name: 'extractMetadata',
      type: FlowStepType.Capability,
      capability: 'messages.extractMessageMetadata',
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      executeCapability: vi.fn().mockResolvedValue({ success: true, data: {} }),
    };
    await executeStep(step, mockCtx, { projectId: 'p1' }, {}, deps);
    expect(deps.executeCapability).toHaveBeenCalledWith(
      'messages.extractMessageMetadata',
      mockCtx,
      {
        projectId: 'p1',
      },
    );
  });

  it('executes a conditional step — true branch', async () => {
    const step: ConditionalStep = {
      name: 'check',
      type: FlowStepType.Conditional,
      if: 'amount > 100',
      then: 'approve',
      else: 'reject',
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      evaluateCondition: vi.fn().mockReturnValue(true),
    };
    const result = await executeStep(step, mockCtx, {}, {}, deps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.nextStep).toBe('approve');
  });

  it('evaluates real flow conditions via evaluateFlowCondition', async () => {
    const { evaluateFlowCondition } = await import('../evaluate-condition.js');
    const step: ConditionalStep = {
      name: 'check',
      type: FlowStepType.Conditional,
      if: 'state.amount > 100',
      then: 'high',
      else: 'low',
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      evaluateCondition: (expr, state) => evaluateFlowCondition(expr, state),
    };
    const result = await executeStep(step, mockCtx, {}, { amount: 150 }, deps);
    expect(result.nextStep).toBe('high');
  });

  it('executes a conditional step — false branch', async () => {
    const step: ConditionalStep = {
      name: 'check',
      type: FlowStepType.Conditional,
      if: 'amount > 100',
      then: 'approve',
      else: 'reject',
    };
    const deps: StepExecutorDeps = {
      ...defaultDeps,
      evaluateCondition: vi.fn().mockReturnValue(false),
    };
    const result = await executeStep(step, mockCtx, {}, {}, deps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.nextStep).toBe('reject');
  });

  it('executes a wait step — returns waitEvent', async () => {
    const step: WaitStep = {
      name: 'waitForApproval',
      type: FlowStepType.Wait,
      event: 'approval.received',
    };
    const result = await executeStep(step, mockCtx, {}, {}, defaultDeps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.waitEvent).toBe('approval.received');
  });

  it('executes a delay step — returns delayDuration', async () => {
    const step: DelayStep = {
      name: 'cooldown',
      type: FlowStepType.Delay,
      duration: '30m',
    };
    const result = await executeStep(step, mockCtx, {}, {}, defaultDeps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.delayDuration).toBe('30m');
  });

  it('executes a parallel step — returns branches', async () => {
    const step: ParallelStep = {
      name: 'parallelWork',
      type: FlowStepType.Parallel,
      branches: ['branchA', 'branchB'],
    };
    const result = await executeStep(step, mockCtx, {}, {}, defaultDeps);
    expect(result.status).toBe(StepStatus.Completed);
    expect(result.parallelBranches).toEqual(['branchA', 'branchB']);
  });

  it('executes an event emit step', async () => {
    const step: EventEmitStep = {
      name: 'notifyComplete',
      type: FlowStepType.EventEmit,
      event: 'order.shipped',
    };
    const result = await executeStep(
      step,
      mockCtx,
      { projectId: 'p1' },
      { orderId: '123' },
      defaultDeps,
    );
    expect(result.status).toBe(StepStatus.Completed);
    expect(mockCtx.events.emit).toHaveBeenCalledWith('order.shipped', {
      projectId: 'p1',
      orderId: '123',
    });
  });

  it('event emit step fails gracefully on emit error', async () => {
    const ctx = {
      events: {
        emit: vi.fn().mockRejectedValue(new Error('emit failed')),
        emitMany: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as ExecutionContext;
    const step: EventEmitStep = {
      name: 'failEmit',
      type: FlowStepType.EventEmit,
      event: 'order.shipped',
    };
    const result = await executeStep(step, ctx, {}, {}, defaultDeps);
    expect(result.status).toBe(StepStatus.Failed);
    expect(result.error).toBe('emit failed');
  });
});

describe('buildHistoryEntry', () => {
  it('creates a history entry', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-01T00:00:01Z');
    const entry = buildHistoryEntry('step1', { status: StepStatus.Completed }, start, end);
    expect(entry).toEqual({
      step: 'step1',
      status: StepStatus.Completed,
      startedAt: start.toISOString(),
      completedAt: end.toISOString(),
      error: undefined,
    });
  });
});
