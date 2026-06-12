import { getCanonicalCapabilityName } from '../execution/canonical-name.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import { zodInputToJsonSchema } from '../schema/zod-input-to-json-schema.js';
import type { CapabilityContract } from '../types/capability.js';
import { isMcpExposed } from './exposure.js';

export interface McpToolAnnotations {
  destructiveHint: boolean;
  readOnlyHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  agentTags?: readonly string[];
  annotations: McpToolAnnotations;
}

export interface McpManifest {
  tools: McpToolDefinition[];
}

function isMcpEligible(cap: CapabilityContract): boolean {
  return isMcpExposed(cap) && cap.kind !== 'eventHandler';
}

export function buildMcpToolDefinition(cap: CapabilityContract): McpToolDefinition {
  const agentTags = cap.mcp?.agentTags;
  const tool: McpToolDefinition = {
    name: getCanonicalCapabilityName(cap),
    description: cap.mcp?.description ?? cap.description ?? getCanonicalCapabilityName(cap),
    inputSchema: zodInputToJsonSchema(cap.input),
    annotations: {
      destructiveHint: cap.mcp?.dangerous ?? false,
      readOnlyHint: cap.kind === 'query',
    },
  };
  if (agentTags !== undefined && agentTags.length > 0) {
    return { ...tool, agentTags };
  }
  return tool;
}

export function buildMcpManifest(registry: CapabilityRegistry): McpManifest {
  const tools = registry
    .getAll()
    .filter(isMcpEligible)
    .map((cap) => buildMcpToolDefinition(cap));
  return { tools };
}
