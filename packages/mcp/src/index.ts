// ── @plumbus/mcp ──
// MCP transport layer for Plumbus capabilities.

export { createMcpAuthAdapter, type McpAuthAdapterConfig } from './auth/mcp-auth-adapter.js';
export { parseBearerToken } from './auth/parse-bearer.js';
export { resolveMcpAgentToken } from './auth/resolve-agent-token.js';
export { createMcpServer, type CreateMcpServerOptions } from './server.js';
export type { McpServerConfig } from './types.js';
export {
  registerMcpOnFastify,
  startHttpServer,
  type RegisterMcpOnFastifyOptions,
  type StartHttpServerOptions,
} from './transports/http.js';
export { startStdioServer } from './transports/stdio.js';
export { mcpTaskEntity } from './tasks/mcp-task-entity.js';
