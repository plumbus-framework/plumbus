import { describe, expect, it, vi } from 'vitest';
import { createTestContext, mockFlows } from '@plumbus/core/testing';
import {
  executeFlowTool,
  runFlowToolCall,
  type FlowToolTurnBudget,
  type FlowToolTurnCounters,
} from '../execute-flow-tool.js';

describe('executeFlowTool', () => {
  it('polls to a terminal completed status', async () => {
    const flows = mockFlows({
      statuses: {
        'flow-exec-1': { id: 'flow-exec-1', flowName: 'demo', status: 'completed' },
      },
    });
    const ctx = createTestContext({ flows });
    const result = await executeFlowTool({
      ctx,
      flowName: 'demo',
      input: { q: 'x' },
      awaitMs: 500,
      pollIntervalMs: 10,
    });
    expect(result.status).toBe('completed');
    expect(result.awaitBudgetElapsed).toBe(false);
  });

  it('reports in_progress and awaitBudgetElapsed when the flow never terminates', async () => {
    const flows = mockFlows({
      statuses: {
        'flow-exec-1': { id: 'flow-exec-1', flowName: 'demo', status: 'running' },
      },
    });
    const ctx = createTestContext({ flows });
    const result = await executeFlowTool({
      ctx,
      flowName: 'demo',
      input: {},
      awaitMs: 30,
      pollIntervalMs: 5,
    });
    expect(result.status).toBe('in_progress');
    expect(result.awaitBudgetElapsed).toBe(true);
  });

  it('does not poll when awaitMs is 0', async () => {
    const flows = mockFlows();
    const statusSpy = vi.spyOn(flows, 'status');
    const ctx = createTestContext({ flows });
    const result = await executeFlowTool({
      ctx,
      flowName: 'demo',
      input: {},
      awaitMs: 0,
      pollIntervalMs: 10,
    });
    expect(statusSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('in_progress');
    expect(result.awaitBudgetElapsed).toBe(true);
  });

  it('returns indeterminate when status() throws', async () => {
    const flows = mockFlows();
    vi.spyOn(flows, 'status').mockRejectedValue(new Error('db unavailable'));
    const ctx = createTestContext({ flows });
    const result = await executeFlowTool({
      ctx,
      flowName: 'demo',
      input: {},
      awaitMs: 100,
      pollIntervalMs: 5,
    });
    expect(result.status).toBe('indeterminate');
  });
});

describe('runFlowToolCall', () => {
  const budget: FlowToolTurnBudget = {
    maxFlowStartsPerTurn: 2,
    flowAwaitBudgetMsPerTurn: 15_000,
    flowAwaitMs: 10_000,
    flowPollIntervalMs: 250,
  };

  const bound = {
    kind: 'flow' as const,
    targetName: 'demo',
    tool: { name: 'flow__demo' },
  };

  it('refuses past maxFlowStartsPerTurn', async () => {
    const flows = mockFlows();
    const startSpy = vi.spyOn(flows, 'start');
    const ctx = createTestContext({ flows });
    const counters: FlowToolTurnCounters = { flowStartsUsed: 2, flowAwaitMsUsed: 0 };
    const result = await runFlowToolCall({
      ctx,
      toolCallId: 'tc-1',
      bound,
      input: {},
      budget,
      counters,
    });
    expect(result.record.status).toBe('not_executed');
    expect(result.record.errorCode).toBe('chat.flow_start_budget_exceeded');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('maps a start throw to chat.tool_arguments_invalid', async () => {
    const flows = mockFlows();
    vi.spyOn(flows, 'start').mockRejectedValue(new Error('invalid input'));
    const ctx = createTestContext({ flows });
    const counters: FlowToolTurnCounters = { flowStartsUsed: 0, flowAwaitMsUsed: 0 };
    const result = await runFlowToolCall({
      ctx,
      toolCallId: 'tc-2',
      bound,
      input: { bad: true },
      budget,
      counters,
    });
    expect(result.record.status).toBe('not_executed');
    expect(result.record.errorCode).toBe('chat.tool_arguments_invalid');
    expect(result.counters.flowStartsUsed).toBe(0);
  });

  it('increments cumulative counters on success', async () => {
    const flows = mockFlows({
      statuses: {
        'flow-exec-1': { id: 'flow-exec-1', flowName: 'demo', status: 'completed' },
      },
    });
    const ctx = createTestContext({ flows });
    const counters: FlowToolTurnCounters = { flowStartsUsed: 1, flowAwaitMsUsed: 0 };
    const result = await runFlowToolCall({
      ctx,
      toolCallId: 'tc-3',
      bound,
      input: {},
      budget,
      counters,
    });
    expect(result.counters.flowStartsUsed).toBe(2);
    expect(result.toolEvent.type).toBe('tool.completed');
  });
});
