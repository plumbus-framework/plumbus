// ── @plumbus/mcp ──
// MCP transport layer for Plumbus capabilities.

export { createMcpAuthAdapter, type McpAuthAdapterConfig } from './auth/mcp-auth-adapter.js';
export { parseBearerToken } from './auth/parse-bearer.js';
export { resolveMcpAgentToken } from './auth/resolve-agent-token.js';
export {
  type CreateMcpServerOptions,
  createMcpServer,
  DEFAULT_MAX_TOOL_INPUT_ELEMENTS,
} from './server.js';
export { createMcpJobCompletionSync } from './tasks/job-completion.js';
export { mcpTaskEntity } from './tasks/mcp-task-entity.js';
export {
  type RegisterMcpOnFastifyOptions,
  registerMcpOnFastify,
  type StartHttpServerOptions,
  startHttpServer,
} from './transports/http.js';
export { startStdioServer } from './transports/stdio.js';
export type { McpServerConfig, McpToolCallInfo } from './types.js';
