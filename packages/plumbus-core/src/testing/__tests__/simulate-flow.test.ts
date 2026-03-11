import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FlowStatus, StepStatus } from '../../flows/state-machine.js';
import { FlowStepType } from '../../types/enums.js';
import type { FlowDefinition } from '../../types/flow.js';
import { simulateFlow } from '../simulate-flow.js';

// ── Test Flow Factories ──

function simpleFlow(): FlowDefinition {
  return {
    name: 'simple-flow',
    domain: 'test',
    input: z.object({ value: z.string() }),
    steps: [
      { name: 'step1', type: FlowStepType.Capability },
      { name: 'step2', type: FlowStepType.Capability },
    ],
  };
}

function conditionalFlow(): FlowDefinition {
  return {
    name: 'conditional-flow',
    domain: 'test',
    input: z.object({}),
    steps: [
      {
        name: 'check',
        type: FlowStepType.Conditional,
        if: 'shouldProceed',
        then: 'proceed',
        else: 'fallback',
      },
      { name: 'proceed', type: FlowStepType.Capability },
      { name: 'fallback', type: FlowStepType.Capability },
    ],
  };
}

function delayFlow(): FlowDefinition {
  return {
    name: 'delay-flow',
    domain: 'test',
    input: z.object({}),
    steps: [
      { name: 'step1', type: FlowStepType.Capability },
      { name: 'wait', type: FlowStepType.Delay, duration: '5m' },
      { name: 'step2', type: FlowStepType.Capability },
    ],
  };
}

function waitFlow(): FlowDefinition {
  return {
    name: 'wait-flow',
    domain: 'test',
    input: z.object({}),
    steps: [
      { name: 'step1', type: FlowStepType.Capability },
      { name: 'waitForApproval', type: FlowStepType.Wait, event: 'approval.received' },
      { name: 'step2', type: FlowStepType.Capability },
    ],
  };
}

function parallelFlow(): FlowDefinition {
  return {
    name: 'parallel-flow',
    domain: 'test',
    input: z.object({}),
    steps: [
      { name: 'fanout', type: FlowStepType.Parallel, branches: ['branchA', 'branchB'] },
      { name: 'branchA', type: FlowStepType.Capability },
      { name: 'branchB', type: FlowStepType.Capability },
      { name: 'merge', type: FlowStepType.Capability },
    ],
  };
}

function eventEmitFlow(): FlowDefinition {
  return {
    name: 'event-emit-flow',
    domain: 'test',
    input: z.object({}),
    steps: [
      { name: 'doWork', type: FlowStepType.Capability },
      { name: 'notify', type: FlowStepType.EventEmit, event: 'work.done' },
    ],
  };
}

// ── Tests ──

describe('simulateFlow', () => {
  it('completes a simple linear flow', async () => {
    const result = await simulateFlow(simpleFlow(), { value: 'test' });
    expect(result.status).toBe(FlowStatus.Completed);
    expect(result.history).toHaveLength(2);
    expect(result.history[0]!.step).toBe('step1');
    expect(result.history[1]!.step).toBe('step2');
  });

  it('records step results by name', async () => {
    const result = await simulateFlow(simpleFlow(), { value: 'test' });
    expect(result.stepResults.get('step1')).toBeDefined();
    expect(result.stepResults.get('step2')).toBeDefined();
    expect(result.stepResults.get('step1')!.status).toBe(StepStatus.Completed);
  });

  it('fails flow when a capability step fails', async () => {
    const result = await simulateFlow(
      simpleFlow(),
      { value: 'test' },
      {
        capabilityResults: {
          step1: { success: false, error: 'step1 failed' },
        },
      },
    );
    expect(result.status).toBe(FlowStatus.Failed);
    expect(result.error).toBe('step1 failed');
    expect(result.history).toHaveLength(1); // Only step1 ran
  });

  it('handles conditional branching (then branch)', async () => {
    const result = await simulateFlow(
      conditionalFlow(),
      {},
      {
        conditionResults: { shouldProceed: true },
      },
    );
    expect(result.status).toBe(FlowStatus.Completed);
    // Should have navigated to "proceed" step
    const stepNames = result.history.map((h) => h.step);
    expect(stepNames).toContain('check');
    expect(stepNames).toContain('proceed');
  });

  it('handles conditional branching (else branch)', async () => {
    const result = await simulateFlow(
      conditionalFlow(),
      {},
      {
        conditionResults: { shouldProceed: false },
      },
    );
    expect(result.status).toBe(FlowStatus.Completed);
    const stepNames = result.history.map((h) => h.step);
    expect(stepNames).toContain('check');
    expect(stepNames).toContain('fallback');
  });

  it('skips delays in simulation', async () => {
    const result = await simulateFlow(delayFlow(), {});
    expect(result.status).toBe(FlowStatus.Completed);
    expect(result.history).toHaveLength(3);
    const stepNames = result.history.map((h) => h.step);
    expect(stepNames).toEqual(['step1', 'wait', 'step2']);
  });

  it('stops at wait-for-event step', async () => {
    const result = await simulateFlow(waitFlow(), {});
    expect(result.status).toBe(FlowStatus.Waiting);
    expect(result.history).toHaveLength(2); // step1 + waitForApproval
    expect(result.history[1]!.step).toBe('waitForApproval');
  });

  it('executes parallel branches', async () => {
    const result = await simulateFlow(parallelFlow(), {});
    expect(result.status).toBe(FlowStatus.Completed);
    const stepNames = result.history.map((h) => h.step);
    expect(stepNames).toContain('branchA');
    expect(stepNames).toContain('branchB');
  });

  it('fails when parallel branch fails', async () => {
    const result = await simulateFlow(
      parallelFlow(),
      {},
      {
        capabilityResults: {
          branchB: { success: false, error: 'branch B failed' },
        },
      },
    );
    expect(result.status).toBe(FlowStatus.Failed);
    expect(result.error).toBe('branch B failed');
  });

  it('handles event emit steps', async () => {
    const result = await simulateFlow(eventEmitFlow(), {});
    expect(result.status).toBe(FlowStatus.Completed);
    expect(result.history).toHaveLength(2);
  });

  it('enforces max step limit', async () => {
    // Create a flow that would loop if conditional always goes to step 1
    const loopFlow: FlowDefinition = {
      name: 'loop',
      domain: 'test',
      input: z.object({}),
      steps: [
        { name: 'doWork', type: FlowStepType.Capability },
        { name: 'checkMore', type: FlowStepType.Conditional, if: 'hasMore', then: 'doWork' },
      ],
    };
    const result = await simulateFlow(
      loopFlow,
      {},
      {
        maxSteps: 5,
        conditionResults: { hasMore: true },
      },
    );
    expect(result.status).toBe(FlowStatus.Failed);
    expect(result.error).toContain('maximum step limit');
  });

  it('passes state through to steps', async () => {
    const result = await simulateFlow(simpleFlow(), { value: 'initial' });
    expect(result.state).toEqual({ value: 'initial' });
  });

  it('uses custom step executor dependencies', async () => {
    const executed: string[] = [];
    const result = await simulateFlow(
      simpleFlow(),
      { value: 'test' },
      {
        stepDeps: {
          executeCapability: async (name) => {
            executed.push(name);
            return { success: true, data: {} };
          },
        },
      },
    );
    expect(result.status).toBe(FlowStatus.Completed);
    expect(executed).toEqual(['step1', 'step2']);
  });
});
