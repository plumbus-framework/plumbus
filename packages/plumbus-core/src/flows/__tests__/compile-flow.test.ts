import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { FlowStepType } from '../../types/enums.js';
import {
  COMPILED_FLOW_CONTRACT_VERSION,
  compileFlowDefinition,
  flowDefinitionId,
  hydrateCompiledFlow,
} from '../compile-flow.js';

function sampleFlow() {
  return defineFlow({
    name: 'order-processing',
    domain: 'orders',
    description: 'Process an order',
    input: z.object({ orderId: z.string() }),
    steps: [
      {
        name: 'validate',
        type: FlowStepType.Capability,
        capability: 'orders.validate',
        input: { orderId: '$input.orderId', region: 'eu' },
      },
      {
        name: 'route',
        type: FlowStepType.Conditional,
        if: 'state.amount > 100',
        then: 'hold',
        else: 'ship',
      },
      { name: 'hold', type: FlowStepType.Wait, event: 'orders.approved' },
      { name: 'ship', type: FlowStepType.Capability, capability: 'orders.ship' },
    ],
    retry: { attempts: 3, backoff: 'exponential' },
  });
}

describe('compileFlowDefinition', () => {
  it('assigns flowDefinitionId as domain.name and defaults version to 1', () => {
    const compiled = compileFlowDefinition(sampleFlow());
    expect(compiled.contractVersion).toBe(COMPILED_FLOW_CONTRACT_VERSION);
    expect(compiled.flowDefinitionId).toBe('orders.order-processing');
    expect(compiled.definitionVersion).toBe('1');
    expect(compiled.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors defineFlow version and compile options', () => {
    const flow = defineFlow({
      name: 'ping',
      domain: 'ops',
      version: '2',
      input: z.object({}),
      steps: [{ name: 'noop', type: FlowStepType.Capability }],
    });
    expect(compileFlowDefinition(flow).definitionVersion).toBe('2');
    expect(compileFlowDefinition(flow, { definitionVersion: '9' }).definitionVersion).toBe('9');
  });

  it('hoists condition expressions and input mappings into digested bindings', () => {
    const compiled = compileFlowDefinition(sampleFlow());
    const route = compiled.steps.find((s) => s.name === 'route');
    const validate = compiled.steps.find((s) => s.name === 'validate');
    expect(route).toMatchObject({
      type: 'conditional',
      then: 'hold',
      else: 'ship',
    });
    expect(route).not.toHaveProperty('if');
    expect(validate).not.toHaveProperty('input');
    expect(compiled.bindings).toHaveLength(2);

    const condition = compiled.bindings.find((b) => b.kind === 'condition');
    const mapping = compiled.bindings.find((b) => b.kind === 'input-mapping');
    expect(condition?.source).toBe('state.amount > 100');
    expect(condition?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(mapping?.source).toContain('$input.orderId');
    expect(route?.conditionBindingId).toBe(condition?.bindingId);
    expect(validate?.inputBindingId).toBe(mapping?.bindingId);

    const json = JSON.stringify(compiled);
    expect(json).not.toContain('"if"');
    expect(json).not.toMatch(/"input":\{/);
  });

  it('compiles and hydrates compensate targets on capability steps', () => {
    const flow = defineFlow({
      name: 'reserve',
      domain: 'inventory',
      input: z.object({ sku: z.string() }),
      steps: [
        {
          name: 'hold',
          type: FlowStepType.Capability,
          capability: 'inventory.reserve',
          compensate: 'inventory.release',
        },
      ],
    });
    const compiled = compileFlowDefinition(flow);
    expect(compiled.steps[0]?.compensate).toBe('inventory.release');
    const hydrated = hydrateCompiledFlow(compiled, flow);
    expect(hydrated.steps[0]).toMatchObject({
      name: 'hold',
      compensate: 'inventory.release',
    });
  });

  it('recompilation of an identical defineFlow is digest-stable', () => {
    const first = compileFlowDefinition(sampleFlow());
    const second = compileFlowDefinition(sampleFlow());
    expect(second.definitionDigest).toBe(first.definitionDigest);
    expect(second.bindings.map((b) => b.digest)).toEqual(first.bindings.map((b) => b.digest));
  });

  it('changing a hoisted expression changes the definition digest', () => {
    const original = compileFlowDefinition(sampleFlow());
    const changed = defineFlow({
      name: 'order-processing',
      domain: 'orders',
      description: 'Process an order',
      input: z.object({ orderId: z.string() }),
      steps: [
        {
          name: 'validate',
          type: FlowStepType.Capability,
          capability: 'orders.validate',
          input: { orderId: '$input.orderId', region: 'eu' },
        },
        {
          name: 'route',
          type: FlowStepType.Conditional,
          if: 'state.amount > 200',
          then: 'hold',
          else: 'ship',
        },
        { name: 'hold', type: FlowStepType.Wait, event: 'orders.approved' },
        { name: 'ship', type: FlowStepType.Capability, capability: 'orders.ship' },
      ],
      retry: { attempts: 3, backoff: 'exponential' },
    });
    expect(compileFlowDefinition(changed).definitionDigest).not.toBe(original.definitionDigest);
  });

  it('compiles approval-outcome routes without inline expressions', () => {
    const flow = defineFlow({
      name: 'refund',
      domain: 'billing',
      input: z.object({}),
      steps: [
        {
          name: 'route',
          type: FlowStepType.ApprovalOutcome,
          outcomes: { approved: 'pay', rejected: 'deny' },
        },
        { name: 'pay', type: FlowStepType.Capability, capability: 'billing.pay' },
        { name: 'deny', type: FlowStepType.Capability, capability: 'billing.deny' },
      ],
    });
    const compiled = compileFlowDefinition(flow);
    const route = compiled.steps.find((s) => s.name === 'route');
    expect(route).toEqual({
      name: 'route',
      type: 'approval-outcome',
      outcomes: { approved: 'pay', rejected: 'deny' },
    });
    expect(JSON.stringify(compiled)).not.toMatch(/function |=>/);
    expect(hydrateCompiledFlow(compiled, flow).steps[0]).toMatchObject({
      type: 'approval-outcome',
      outcomes: { approved: 'pay', rejected: 'deny' },
    });
  });

  it('hydrates compiled bindings back onto authoring Zod schemas', () => {
    const authoring = sampleFlow();
    const compiled = compileFlowDefinition(authoring);
    const live = hydrateCompiledFlow(compiled, authoring);
    expect(live.input).toBe(authoring.input);
    expect(live.steps).toEqual(authoring.steps);
    expect(flowDefinitionId(live)).toBe('orders.order-processing');
  });
});
