// MCP authentication is validated before importing app resources or opening connections.
import { z } from 'zod';
import { type AuthAdapter, createJwtAdapter } from '../auth/index.js';
import { loadAppConfig } from '../config/index.js';
import { createErrorService } from '../errors/index.js';
import { loadServerExtensions } from '../runtime/load-extensions.js';
import { buildResourceContext, type ResourceContext } from '../runtime/resource-context.js';
import type { PlumbusConfig } from '../types/config.js';
import { discoverResources } from './discover.js';
import { warn } from './utils.js';

export type McpServeContext = ResourceContext;

async function resolveMcpServeAuthAdapter(config: PlumbusConfig): Promise<AuthAdapter> {
  if (config.mcp?.agents && Object.keys(config.mcp.agents).length > 0) {
    const { createMcpAuthAdapter } = await import('@plumbus/mcp');
    return createMcpAuthAdapter({
      agents: config.mcp.agents,
      envToken: process.env.PLUMBUS_MCP_TOKEN,
    });
  }
  const secret = config.auth.secret;
  const isDevelopmentPlaceholder = [
    'development-secret',
    'development-secret-placeholder-32chars-min',
  ].includes(secret?.trim() ?? '');
  if (config.environment === 'development' && !secret) {
    warn(
      'MCP authentication is not configured — development requests will be anonymous and only `access.public: true` capabilities will be callable. Configure mcp.agents or AUTH_SECRET for authenticated access. See docs/mcp/agent-authentication.md.',
    );
    return { authenticate: async () => null };
  }

  const validatedSecret = z
    .string()
    .refine((value) => value.trim().length >= 32 && !isDevelopmentPlaceholder)
    .safeParse(secret);
  if (!validatedSecret.success) {
    throw createErrorService().validation(
      'MCP serve requires mcp.agents or an explicit AUTH_SECRET of at least 32 non-padding characters; development placeholder secrets are not accepted. Anonymous access is available only in development.',
    );
  }

  warn(
    'mcp.agents is not configured — MCP Bearer tokens will be verified using auth.secret (AUTH_SECRET). See docs/mcp/agent-authentication.md.',
  );
  return createJwtAdapter({
    secret: validatedSecret.data,
    issuer: config.auth.issuer,
    audience: config.auth.audience,
  });
}

export async function buildMcpServeContext(): Promise<McpServeContext> {
  const config = await loadAppConfig();
  // Reject unsafe auth configuration before discovery or opening DB/queue connections.
  const authAdapter = await resolveMcpServeAuthAdapter(config);
  const resources = await discoverResources();

  const extensions = await loadServerExtensions(undefined, resources.decisions);
  return buildResourceContext({
    config,
    resources,
    extensions,
    authAdapter,
    component: 'mcp-capability',
    openQueues: true,
    enableFlows: true,
  });
}
