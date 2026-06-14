import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry, defineCapability, evaluateAccess } from '@plumbus/core';
import type { CapabilityContract } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { createMcpAuthAdapter } from '../auth/mcp-auth-adapter.js';
import { resolveMcpAgentToken } from '../auth/resolve-agent-token.js';
import { createMcpServer } from '../server.js';
import type { McpServerConfig } from '../types.js';

describe('createMcpAuthAdapter', () => {
  const agents = {
    'agent-a': {
      serviceAccountId: 'billing-agent',
      scopes: ['billing:read'],
      tenantId: 'tenant-1',
    },
    'secret-key': {
      serviceAccountId: 'ops-agent',
      scopes: [],
    },
  };

  it('authenticates Bearer token', async () => {
    const adapter = createMcpAuthAdapter({ agents });
    const auth = await adapter.authenticate('Bearer agent-a');
    expect(auth?.userId).toBe('billing-agent');
    expect(auth?.provider).toBe('mcp');
    expect(auth?.tenantId).toBe('tenant-1');
  });

  it('returns null for unknown token', async () => {
    const adapter = createMcpAuthAdapter({ agents });
    expect(await adapter.authenticate('Bearer unknown')).toBeNull();
  });

  it('resolves PLUMBUS_MCP_TOKEN env key', () => {
    expect(resolveMcpAgentToken(undefined, agents, 'agent-a')).toBe('agent-a');
    expect(resolveMcpAgentToken(undefined, agents, 'missing')).toBeNull();
  });
});

describe('MCP access with serviceAccounts', () => {
  const cap = defineCapability({
    name: 'getRefund',
    kind: 'query',
    domain: 'billing',
    description: 'Get refund',
    exposeAs: ['mcp'],
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    access: {
      serviceAccounts: ['billing-agent'],
      tenantScoped: true,
    },
    effects: { data: ['Refund'], events: [], external: [], ai: false },
    handler: async (_ctx, input) => ({ id: input.id }),
  });

  it('denies when service account not listed', async () => {
    const adapter = createMcpAuthAdapter({
      agents: { tok: { serviceAccountId: 'other-agent', scopes: [] } },
    });
    const auth = await adapter.authenticate('Bearer tok');
    expect(auth).not.toBeNull();
    const result = evaluateAccess(cap.access, auth as NonNullable<typeof auth>);
    expect(result.allowed).toBe(false);
  });

  it('allows listed service account', async () => {
    const adapter = createMcpAuthAdapter({
      agents: {
        tok: { serviceAccountId: 'billing-agent', scopes: [], tenantId: 'tenant-1' },
      },
    });
    const auth = await adapter.authenticate('Bearer tok');
    expect(auth).not.toBeNull();
    const result = evaluateAccess(cap.access, auth as NonNullable<typeof auth>);
    expect(result.allowed).toBe(true);
  });
});

describe('MCP tools/call with createMcpAuthAdapter', () => {
  const agents = {
    'agent-t1': {
      serviceAccountId: 'billing-agent',
      scopes: [],
      tenantId: 'tenant-1',
    },
  };

  const tenantCap = defineCapability({
    name: 'getTenantResource',
    kind: 'query',
    domain: 'billing',
    description: 'Tenant-scoped resource',
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
        throw ctx.errors.forbidden('Cross-tenant access denied');
      }
      return { ok: true };
    },
  });

  const registry = new CapabilityRegistry();
  registry.register(tenantCap as unknown as CapabilityContract);

  async function callWithBearer(
    token: string,
    args: { resourceTenantId: string },
  ): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const origSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) =>
      origSend(message, {
        ...options,
        authInfo: { token, clientId: 'test-client', scopes: [] },
      });

    const config: McpServerConfig = {
      registry,
      db: {} as McpServerConfig['db'],
      authAdapter: createMcpAuthAdapter({ agents }),
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

    const server = createMcpServer(config);
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'billing.getTenantResource',
      arguments: args,
    });
    return {
      isError: result.isError === true,
      content: result.content as Array<{ type: string; text?: string }>,
    };
  }

  it('denies cross-tenant tools/call when Bearer resolves tenanted agent', async () => {
    const denied = await callWithBearer('agent-t1', { resourceTenantId: 'tenant-2' });
    expect(denied.isError).toBe(true);
  });

  it('allows tools/call for matching tenant via Bearer', async () => {
    const allowed = await callWithBearer('agent-t1', { resourceTenantId: 'tenant-1' });
    expect(allowed.isError).toBeFalsy();
  });
});
