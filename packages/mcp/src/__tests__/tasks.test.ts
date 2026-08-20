import {
  CancelTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { describe, expect, it } from 'vitest';
import { mcpTaskEntity } from '../tasks/mcp-task-entity.js';
import { createTestMcpServer } from '../testing/create-test-mcp-server.js';

const slowReport = defineCapability({
  name: 'slowReport',
  kind: 'job',
  domain: 'reports',
  description: 'Generate a slow report (test fixture)',
  input: z.object({ items: z.number() }),
  output: z.object({ done: z.boolean(), processed: z.number() }),
  access: { roles: ['user'] },
  effects: { data: [], events: [], external: [], ai: false },
  exposeAs: ['mcp'],
  mcp: { description: 'Test slow report' },
  async handler(ctx, input) {
    for (let i = 1; i <= input.items; i++) {
      ctx.progress?.report({ progress: i, total: input.items });
      await new Promise((r) => setTimeout(r, 5));
    }
    return { done: true, processed: input.items };
  },
});

describe('MCP tasks for kind:job', () => {
  it('runs a job through the tasks model end-to-end', async () => {
    const { client, close } = await createTestMcpServer({
      capabilities: [slowReport],
      entities: [mcpTaskEntity],
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'mcp' },
    });
    try {
      const createResult = (await client.callTool({
        name: 'reports.slowReport',
        arguments: { items: 3 },
        _meta: { taskMetadata: {} },
      } as any)) as any;
      const taskId: string = createResult.task.taskId;
      expect(taskId).toBeDefined();
      expect(createResult.task.status).toBe('working');

      let status: string = 'working';
      for (let i = 0; i < 30 && status === 'working'; i++) {
        const got = await client.request(
          { method: 'tasks/get', params: { taskId } },
          GetTaskResultSchema,
        );
        status = got.status;
        if (status === 'working') await new Promise((r) => setTimeout(r, 10));
      }
      expect(status).toBe('completed');

      const payload = await client.request(
        { method: 'tasks/result', params: { taskId } },
        GetTaskPayloadResultSchema,
      );
      expect(payload.done).toBe(true);
      expect(payload.processed).toBe(3);
    } finally {
      await close();
    }
  });

  it('persists reported progress onto the task row through the background context', async () => {
    const observed: unknown[] = [];
    const reportsProgress = defineCapability({
      name: 'reportsProgress',
      kind: 'job',
      domain: 'reports',
      description: 'Reports progress and reads it back off its own task row',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      access: { roles: ['user'] },
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['mcp'],
      mcp: { description: 'Progress probe' },
      async handler(ctx) {
        ctx.progress?.report({ progress: 1, total: 2, message: 'halfway' });
        // recordProgress is fire-and-forget; let the write settle before reading.
        await new Promise((r) => setTimeout(r, 20));
        const rows = (await ctx.data.McpTask?.findMany()) as
          | Array<{ lastProgressJson?: unknown }>
          | undefined;
        observed.push(...(rows ?? []).map((row) => row.lastProgressJson));
        return { done: true };
      },
    });

    const { client, close } = await createTestMcpServer({
      capabilities: [reportsProgress],
      entities: [mcpTaskEntity],
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'mcp' },
    });
    try {
      const created = (await client.callTool({
        name: 'reports.reportsProgress',
        arguments: {},
        _meta: { taskMetadata: {} },
      } as any)) as any;
      const taskId: string = created.task.taskId;

      let status: string = 'working';
      for (let i = 0; i < 30 && status === 'working'; i++) {
        const got = await client.request(
          { method: 'tasks/get', params: { taskId } },
          GetTaskResultSchema,
        );
        status = got.status;
        if (status === 'working') await new Promise((r) => setTimeout(r, 10));
      }
      expect(status).toBe('completed');
      expect(observed).toEqual([{ progress: 1, total: 2, message: 'halfway' }]);
    } finally {
      await close();
    }
  });

  it('cancels a running task and marks it cancelled', async () => {
    const longJob = defineCapability({
      name: 'longJob',
      kind: 'job',
      domain: 'reports',
      description: 'A job that respects ctx.signal',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      access: { roles: ['user'] },
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['mcp'],
      mcp: { description: 'Cancellable job' },
      async handler(ctx) {
        for (let i = 0; i < 50; i++) {
          if (ctx.signal?.aborted) return { done: false };
          await new Promise((r) => setTimeout(r, 5));
        }
        return { done: true };
      },
    });
    const { client, close } = await createTestMcpServer({
      capabilities: [longJob],
      entities: [mcpTaskEntity],
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'mcp' },
    });
    try {
      const created = (await client.callTool({
        name: 'reports.longJob',
        arguments: {},
        _meta: { taskMetadata: {} },
      } as any)) as any;
      const taskId: string = created.task.taskId;
      await new Promise((r) => setTimeout(r, 10));
      const cancelled = await client.request(
        { method: 'tasks/cancel', params: { taskId } },
        CancelTaskResultSchema,
      );
      expect(['cancelled', 'working']).toContain(cancelled.status);
      await new Promise((r) => setTimeout(r, 30));
      const final = await client.request(
        { method: 'tasks/get', params: { taskId } },
        GetTaskResultSchema,
      );
      expect(final.status).toBe('cancelled');
    } finally {
      await close();
    }
  });
});
