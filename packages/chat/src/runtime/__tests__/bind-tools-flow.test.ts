import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@plumbus/core';
import { createTestContext, mockFlows } from '@plumbus/core/testing';
import { bindFlowTool, bindFlowTools } from '../bind-tools.js';

const demoDescribe = {
  name: 'demo',
  domain: 'test',
  description: 'Demo flow',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

function ctxWithFlows(flows: ReturnType<typeof mockFlows>): ExecutionContext {
  return createTestContext({ flows });
}

describe('bindFlowTool', () => {
  it('binds a flow as flow__<name> in auto mode', () => {
    const flows = mockFlows({ describe: { demo: demoDescribe } });
    const ctx = ctxWithFlows(flows);
    const result = bindFlowTool(ctx, 'demo');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bound.tool.name).toBe('flow__demo');
    expect(result.bound.kind).toBe('flow');
    expect(result.bound.mode).toBe('auto');
    expect(result.bound.targetVersion).toBe(result.bound.inputSchemaHash);
  });

  it('returns chat.tool_unknown_flow when describe returns undefined', () => {
    const flows = mockFlows({ describe: {} });
    const ctx = ctxWithFlows(flows);
    const result = bindFlowTool(ctx, 'missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('chat.tool_unknown_flow');
  });

  it('returns chat.tool_flow_schema_invalid when parameters is undefined', () => {
    const flows = mockFlows({
      describe: {
        bad: { ...demoDescribe, parameters: undefined },
      },
    });
    const ctx = ctxWithFlows(flows);
    const result = bindFlowTool(ctx, 'bad');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('chat.tool_flow_schema_invalid');
  });

  it('returns chat.tool_name_invalid for a >57-char flow name', () => {
    const longName = `a${'b'.repeat(58)}`;
    const flows = mockFlows({
      describe: {
        [longName]: { ...demoDescribe, name: longName },
      },
    });
    const ctx = ctxWithFlows(flows);
    const result = bindFlowTool(ctx, longName);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('chat.tool_name_invalid');
  });

  it('returns chat.tools_flows_unavailable when describe is not a function', () => {
    const base = createTestContext();
    const ctx: ExecutionContext = {
      ...base,
      flows: {
        ...base.flows,
        describe: undefined,
      },
    };
    const result = bindFlowTool(ctx, 'demo');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('chat.tools_flows_unavailable');
  });

  it('bindFlowTools aggregates tools and per-flow errors', () => {
    const flows = mockFlows({ describe: { demo: demoDescribe } });
    const ctx = ctxWithFlows(flows);
    const { tools, errors } = bindFlowTools(ctx, ['demo', 'missing']);
    expect(tools).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(tools[0]?.tool.name).toBe('flow__demo');
    expect(errors[0]?.code).toBe('chat.tool_unknown_flow');
  });
});
