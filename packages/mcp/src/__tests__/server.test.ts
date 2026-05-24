import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CapabilityRegistry,
  defineCapability,
  type AuthAdapter,
  type CapabilityContract,
} from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { buildMcpManifest } from '@plumbus/core/mcp';
import { createMcpAuthAdapter } from '../auth/mcp-auth-adapter.js';
import { createMcpServer } from '../server.js';
import type { McpServerConfig } from '../types.js';

describe('createMcpServer', () => {
  const mcpCap = defineCapability({
    name: 'echo',
    kind: 'query',
    domain: 'test',
    description: 'Echo input',
    exposeAs: ['mcp'],
    input: z.object({ message: z.string() }),
    output: z.object({ message: z.string() }),
    access: { public: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (_ctx, input) => ({ message: input.message }),
  });

  const privateCap = defineCapability({
    name: 'secret',
    kind: 'query',
    domain: 'test',
    description: 'Not exposed',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  });

  const restrictedCap = defineCapability({
    name: 'restricted',
    kind: 'query',
    domain: 'test',
    description: 'Service account only',
    exposeAs: ['mcp'],
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    access: { serviceAccounts: ['billing-agent'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  });

  const registry = new CapabilityRegistry();
  registry.registerAll([mcpCap, privateCap, restrictedCap] as unknown as CapabilityContract[]);

  function testDependenciesFromAuth(
    auth: Parameters<McpServerConfig['createDependencies']>[0],
  ): ReturnType<McpServerConfig['createDependencies']> {
    const ctx = createTestContext({ auth });
    return {
      auth: ctx.auth,
      data: ctx.data,
      events: ctx.events,
      flows: ctx.flows,
      audit: ctx.audit,
      logger: ctx.logger,
      time: ctx.time,
      config: ctx.config,
      translations: ctx.translations,
    };
  }

  function buildConfig(authAdapter: AuthAdapter): McpServerConfig {
    return {
      registry,
      db: {} as McpServerConfig['db'],
      authAdapter,
      createDependencies: testDependenciesFromAuth,
    };
  }

  async function connectClient(config: McpServerConfig): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(config);
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('buildMcpManifest lists only MCP tools', () => {
    const manifest = buildMcpManifest(registry);
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(['echo', 'restricted']);
  });

  it('creates MCP server instance', () => {
    const server = createMcpServer(
      buildConfig({
        async authenticate() {
          return null;
        },
      }),
    );
    expect(server).toBeDefined();
  });

  it('tools/call succeeds for authorized public tool', async () => {
    const client = await connectClient(
      buildConfig({
        async authenticate() {
          return {
            userId: 'test',
            roles: [],
            scopes: [],
            provider: 'test',
          };
        },
      }),
    );

    const result = await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0];
    expect(text?.type).toBe('text');
    if (text?.type === 'text' && text.text) {
      expect(JSON.parse(text.text)).toEqual({ message: 'hi' });
    }
  });

  it('tools/call returns isError when access is denied', async () => {
    const client = await connectClient(
      buildConfig({
        async authenticate() {
          return null;
        },
      }),
    );

    const result = await client.callTool({ name: 'restricted', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('tools/call returns isError for unknown tool', async () => {
    const client = await connectClient(
      buildConfig({
        async authenticate() {
          return { userId: 'test', roles: [], scopes: [], provider: 'test' };
        },
      }),
    );

    const result = await client.callTool({ name: 'missing-tool', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0];
    if (text?.type === 'text' && text.text) {
      const body = JSON.parse(text.text) as { code?: string };
      expect(body.code).toBe('not_found');
    }
  });
});

describe('createMcpServer tenant isolation (e2e)', () => {
  const tenantScopedCap = defineCapability({
    name: 'getTenantResource',
    kind: 'query',
    domain: 'billing',
    description: 'Fetch resource in caller tenant',
    exposeAs: ['mcp'],
    input: z.object({ resourceTenantId: z.string() }),
    output: z.object({ ok: z.boolean() }),
    access: {
      serviceAccounts: ['billing-agent'],
      tenantScoped: true,
    },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (ctx, input) => {
      if (input.resourceTenantId !== ctx.auth.tenantId) {
        throw ctx.errors.forbidden('Cross-tenant access denied', {
          capability: 'getTenantResource',
          requestedTenant: input.resourceTenantId,
          callerTenant: ctx.auth.tenantId,
        });
      }
      return { ok: true };
    },
  });

  const registry = new CapabilityRegistry();
  registry.register(tenantScopedCap as unknown as CapabilityContract);

  const agents = {
    'agent-t1': {
      serviceAccountId: 'billing-agent',
      scopes: [],
      tenantId: 'tenant-1',
    },
  };

  it('denies tools/call when tenanted agent targets another tenant', async () => {
    const inner = createMcpAuthAdapter({ agents });
    const authAdapter: AuthAdapter = {
      async authenticate(header) {
        const token = header ?? 'Bearer agent-t1';
        return inner.authenticate(token.startsWith('Bearer ') ? token : `Bearer ${token}`);
      },
    };
    const config: McpServerConfig = {
      registry,
      db: {} as McpServerConfig['db'],
      authAdapter,
      createDependencies: (auth) => {
        const ctx = createTestContext({ auth });
        return {
          auth: ctx.auth,
          data: ctx.data,
          events: ctx.events,
          flows: ctx.flows,
          audit: ctx.audit,
          logger: ctx.logger,
          time: ctx.time,
          config: ctx.config,
          translations: ctx.translations,
        };
      },
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(config);
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const denied = await client.callTool({
      name: 'getTenantResource',
      arguments: { resourceTenantId: 'tenant-2' },
    });
    expect(denied.isError).toBe(true);

    const allowed = await client.callTool({
      name: 'getTenantResource',
      arguments: { resourceTenantId: 'tenant-1' },
    });
    expect(allowed.isError).toBeFalsy();
  });
});
