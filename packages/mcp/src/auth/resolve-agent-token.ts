import type { McpAgentConfig } from '@plumbus/core';
import { parseBearerToken } from './parse-bearer.js';

/**
 * Resolve configured agent map key from Bearer header and/or PLUMBUS_MCP_TOKEN-style value.
 * See docs/mcp/agent-authentication.md for precedence rules.
 */
export function resolveMcpAgentToken(
  authorizationHeader: string | undefined,
  agents: Record<string, McpAgentConfig>,
  envToken?: string,
): string | null {
  const bearer = parseBearerToken(authorizationHeader);
  if (bearer !== null && Object.hasOwn(agents, bearer)) {
    return bearer;
  }

  const raw = envToken?.trim();
  if (!raw) {
    return null;
  }

  if (Object.hasOwn(agents, raw)) {
    return raw;
  }

  return null;
}
