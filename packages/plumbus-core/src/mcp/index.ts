// ── MCP codegen ──
// Manifest and skill file generation from capability contracts.

export { isMcpExposed } from './exposure.js';
export {
  buildMcpManifest,
  buildMcpToolDefinition,
  type McpManifest,
  type McpToolAnnotations,
  type McpToolDefinition,
} from './manifest-generator.js';
export { renderSkillFile } from './skill-generator.js';
