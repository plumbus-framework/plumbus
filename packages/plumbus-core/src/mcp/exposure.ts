import type { CapabilityContract } from '../types/capability.js';

/** True when the capability is exposed as an MCP tool (`exposeAs: ['mcp']` only). */
export function isMcpExposed(cap: CapabilityContract): boolean {
  return cap.exposeAs?.includes('mcp') ?? false;
}
