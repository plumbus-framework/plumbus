import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type AuthContext,
  CapabilityRegistry,
  type ContextDependencies,
  defineCapability,
} from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { z } from '@plumbus/core/zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpTaskEntity } from '../tasks/mcp-task-entity.js';
import { type RegisterMcpOnFastifyOptions, registerMcpOnFastify } from '../transports/http.js';
import type { McpServerConfig } from '../types.js';

const echo = defineCapability({
  name: 'echo',
  domain: 'test',
  description: 'Echo fixture',
  kind: 'query',
  exposeAs: ['mcp'],
  access: { public: true },
  input: z.object({ items: z.array(z.number()).optional(), n: z.number().optional() }),
  output: z.object({ n: z.number() }),
  effects: { data: [], events: [], external: [], ai: false },
  handler: async (_ctx, input) => ({ n: input.n ?? input.items?.length ?? 0 }),
});

const quickJob = defineCapability({
  name: 'quickJob',
  domain: 'test',
  description: 'Job fixture',
  kind: 'job',
  exposeAs: ['mcp'],
  access: { roles: ['user'] },
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  effects: { data: [], events: [], external: [], ai: false },
  handler: async () => ({ done: true }),
});

/** Tokens map to principals: same user+tenant for `a1`/`a2`, a different user for `b`. */
const PRINCIPALS: Record<string, AuthContext> = {
  'Bearer a1': { userId: 'alice', tenantId: 't1', roles: ['user'], scopes: [], provider: 'mcp' },
  'Bearer a2': { userId: 'alice', tenantId: 't1', roles: ['user'], scopes: [], provider: 'mcp' },
  'Bearer b': { userId: 'bob', tenantId: 't1', roles: ['user'], scopes: [], provider: 'mcp' },
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startServer(
  options: RegisterMcpOnFastifyOptions,
  extra: Partial<McpServerConfig> = {},
): Promise<URL> {
  const registry = new CapabilityRegistry();
  registry.register(echo);
  registry.register(quickJob);
  const shared = createTestContext({ entities: [mcpTaskEntity] });
  const config: McpServerConfig = {
    registry,
    db: {} as McpServerConfig['db'],
    authAdapter: { authenticate: async (header) => (header && PRINCIPALS[header]) || null },
    createDependencies: (auth): ContextDependencies => ({
      auth,
      data: shared.data,
      events: shared.events,
      flows: shared.flows,
      audit: shared.audit,
      logger: shared.logger,
      time: shared.time,
      config: shared.config,
      translations: shared.translations,
      ai: shared.ai,
    }),
    ...extra,
  };
  app = Fastify();
  await registerMcpOnFastify(app, config, options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function connect(
  url: URL,
  token: string,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: token } },
  });
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function startTask(client: Client): Promise<string> {
  const created = (await client.callTool({
    name: 'test.quickJob',
    arguments: {},
    _meta: { taskMetadata: {} },
  } as never)) as { task: { taskId: string } };
  return created.task.taskId;
}

async function waitCompleted(client: Client, taskId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const got = await client.request(
      { method: 'tasks/get', params: { taskId } },
      GetTaskResultSchema,
    );
    if (got.status === 'completed') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('task did not complete');
}

describe('stateless HTTP transport', () => {
  it('serves many sequential requests and clients', async () => {
    const url = await startServer({});
    const { client } = await connect(url, 'Bearer a1');
    for (let i = 0; i < 20; i++) {
      const result = (await client.callTool({ name: 'test.echo', arguments: { n: i } })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({ n: i });
    }
    await client.close();
    const second = await connect(url, 'Bearer b');
    expect((await second.client.listTools()).tools.map((t) => t.name)).toContain('test.echo');
    await second.client.close();
  });

  it('refuses tool arguments over maxToolInputElements', async () => {
    const url = await startServer({}, { maxToolInputElements: 10 });
    const { client } = await connect(url, 'Bearer a1');
    await expect(
      client.callTool({ name: 'test.echo', arguments: { items: Array(20).fill(1) } }),
    ).rejects.toThrow(/maximum of 10 elements/);
    const ok = (await client.callTool({ name: 'test.echo', arguments: { items: [1, 2] } })) as {
      isError?: boolean;
    };
    expect(ok.isError).toBeUndefined();
    await client.close();
  });

  it('refuses request bodies over maxRequestBodySize with 413', async () => {
    const url = await startServer({ maxRequestBodySize: 1024 });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a1',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test.echo', arguments: { pad: 'x'.repeat(4096) } },
      }),
    });
    expect(response.status).toBe(413);
  });
});

describe('stateful HTTP transport', () => {
  it('gives each client its own session', async () => {
    const url = await startServer({ stateless: false });
    const one = await connect(url, 'Bearer a1');
    const two = await connect(url, 'Bearer a2');
    expect(one.transport.sessionId).toBeDefined();
    expect(two.transport.sessionId).toBeDefined();
    expect(one.transport.sessionId).not.toBe(two.transport.sessionId);
    expect((await one.client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await two.client.listTools()).tools.length).toBeGreaterThan(0);
    await one.client.close();
    await two.client.close();
  });

  it('answers 404 when another principal presents a session id, and keeps the session', async () => {
    const url = await startServer({ stateless: false });
    const owner = await connect(url, 'Bearer a1');
    const sessionId = owner.transport.sessionId as string;
    const headers = {
      authorization: 'Bearer b',
      'mcp-session-id': sessionId,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const post = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(post.status).toBe(404);
    const { 'content-type': _ct, ...bodyless } = headers;
    const sse = await fetch(url, { method: 'GET', headers: bodyless });
    expect(sse.status).toBe(404);
    const del = await fetch(url, { method: 'DELETE', headers: bodyless });
    expect(del.status).toBe(404);
    // The owner's session survived the attempts.
    expect((await owner.client.listTools()).tools.length).toBeGreaterThan(0);
    await owner.client.close();
  });

  it('closes the session on DELETE', async () => {
    const url = await startServer({ stateless: false });
    const { client, transport } = await connect(url, 'Bearer a1');
    const sessionId = transport.sessionId as string;
    await transport.terminateSession();
    const after = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a1',
        'mcp-session-id': sessionId,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
    await client.close();
  });

  it('closes idle sessions when sessionIdleTimeoutMs is set', async () => {
    const url = await startServer({ stateless: false, sessionIdleTimeoutMs: 50 });
    // Initialize by hand: the SDK client would hold a GET stream open, which keeps a session active.
    const init = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a1',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'idle-test', version: '0.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    await init.text();
    const sessionId = init.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 150));
    const after = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a1',
        'mcp-session-id': sessionId,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
  });

  it('keeps tasks inside the session that created them (same user + tenant)', async () => {
    const url = await startServer({ stateless: false });
    const one = await connect(url, 'Bearer a1');
    const two = await connect(url, 'Bearer a2');
    const taskId = await startTask(one.client);
    await waitCompleted(one.client, taskId);

    const own = await one.client.request(
      { method: 'tasks/list', params: {} },
      ListTasksResultSchema,
    );
    expect(own.tasks.map((t) => t.taskId)).toContain(taskId);
    const payload = await one.client.request(
      { method: 'tasks/result', params: { taskId } },
      GetTaskPayloadResultSchema,
    );
    expect(payload.done).toBe(true);

    const other = await two.client.request(
      { method: 'tasks/list', params: {} },
      ListTasksResultSchema,
    );
    expect(other.tasks.map((t) => t.taskId)).not.toContain(taskId);
    for (const method of ['tasks/get', 'tasks/result', 'tasks/cancel'] as const) {
      await expect(
        two.client.request({ method, params: { taskId } }, GetTaskResultSchema),
      ).rejects.toThrow(/task\.not_found/);
    }
    await one.client.close();
    await two.client.close();
  });
});
