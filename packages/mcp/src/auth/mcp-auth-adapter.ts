import type { AuthAdapter, AuthContext, McpAgentConfig } from '@plumbus/core';
import { resolveMcpAgentToken } from './resolve-agent-token.js';

export interface McpAuthAdapterConfig {
  agents: Record<string, McpAgentConfig>;
  /** Optional env token for stdio (e.g. process.env.PLUMBUS_MCP_TOKEN) */
  envToken?: string;
}

export function createMcpAuthAdapter(config: McpAuthAdapterConfig): AuthAdapter {
  const { agents, envToken } = config;

  return {
    async authenticate(authorizationHeader: string | undefined): Promise<AuthContext | null> {
      const key = resolveMcpAgentToken(authorizationHeader, agents, envToken);
      if (key === null) {
        return null;
      }

      // resolveMcpAgentToken already verified Object.hasOwn(agents, key).
      const agent = Object.hasOwn(agents, key) ? agents[key] : undefined;
      if (!agent) {
        return null;
      }

      return {
        userId: agent.serviceAccountId,
        roles: [],
        scopes: [...agent.scopes],
        tenantId: agent.tenantId,
        provider: 'mcp',
        sessionId: undefined,
        internal: false,
      };
    },
  };
}
