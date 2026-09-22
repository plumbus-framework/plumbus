import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from '@plumbus/core/zod';
import { CapabilityRegistry, defineCapability } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { registerMcpOnFastify } from '../transports/http.js';
import { createTestMcpServer } from '../testing/create-test-mcp-server.js';
import { createMcpJobCompletionSync } from '../tasks/job-completion.js';

it('authenticates the HTTP transport while preserving public discovery', async () => {
  const app = Fastify();
  const { server } = await registerMcpOnFastify(app, {
    registry: new CapabilityRegistry(),
    db: {} as never,
    authAdapter: {
      async authenticate(header) {
        return header === 'Bearer valid'
          ? { userId: 'u', roles: [], scopes: [], provider: 'test' }
          : null;
      },
    },
    createDependencies: (auth) => ({ auth, data: {} }),
  });
  try {
    for (const authorization of [undefined, 'Bearer invalid']) {
      const result = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: authorization ? { authorization } : {},
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(result.statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/mcp/discovery' })).statusCode).toBe(200);
    const allowed = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer valid', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(allowed.statusCode).toBe(200);
  } finally {
    await server.close();
    await app.close();
  }
});

it('filters raw handler errors and metadata from MCP responses', async () => {
  const cap = defineCapability({
    name: 'fail',
    domain: 'test',
    description: 'Security regression fixture',
    kind: 'query',
    exposeAs: ['mcp'],
    access: { public: true },
    input: z.object({}),
    output: z.object({}),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (ctx) => {
      throw ctx.errors.internal('secret database URL', {
        password: 'secret password',
        stack: '/private/path',
      });
    },
  });
  const server = await createTestMcpServer({ capabilities: [cap] });
  try {
    const result = await server.client.callTool({ name: 'test.fail', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('An internal error occurred');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('/private/path');
  } finally {
    await server.close();
  }
});

it('rejects invalid task input before creating task storage or executing a job', async () => {
  const handler = vi.fn(async () => ({}));
  const cap = defineCapability({
    name: 'job',
    domain: 'test',
    description: 'Security regression fixture',
    kind: 'job',
    exposeAs: ['mcp'],
    access: { roles: ['user'] },
    input: z.object({ count: z.number() }),
    output: z.object({}),
    effects: { data: [], events: [], external: [], ai: false },
    handler,
  });
  const server = await createTestMcpServer({
    capabilities: [cap],
    auth: { userId: 'u', roles: ['user'], provider: 'test' },
  });
  try {
    const result = await server.client.callTool({
      name: 'test.job',
      arguments: { count: 'bad' },
      _meta: { taskMetadata: {} },
    } as any);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Invalid input');
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

describe('worker task completion scopes', () => {
  it.each([
    undefined,
    'tenant-a',
  ])('binds repositories to job tenant %s and refuses mismatches', async (tenantId) => {
    const update = vi.fn(async () => ({}));
    let rowTenant = tenantId;
    const factory = vi.fn((tenantId?: string) => {
      const ctx = createTestContext({
        auth: { userId: 'worker', roles: ['system'], scopes: [], provider: 'worker', tenantId },
      });
      return {
        ...ctx,
        data: {
          McpTask: { findById: async () => ({ id: 'job', tenantId: rowTenant }), update },
        } as any,
      };
    });
    const sync = createMcpJobCompletionSync(factory);
    await sync('job', 'completed', { ok: true }, undefined, tenantId);
    expect(factory).toHaveBeenCalledWith(tenantId);
    expect(update).toHaveBeenCalledTimes(1);
    rowTenant = 'different';
    await sync('job', 'completed', {}, undefined, tenantId);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
