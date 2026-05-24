import type { z } from 'zod';
import type { ExecutionContext } from './context.js';
import type { CapabilityKind } from './enums.js';
import type { AccessPolicy } from './security.js';

// ── Capability Effects ──
export interface CapabilityEffects {
  data: string[];
  events: string[];
  external: string[];
  flows?: string[];
  ai: boolean;
}

// ── Capability Audit Config ──
export interface CapabilityAuditConfig {
  enabled?: boolean;
  event: string;
  includeInput?: string[];
  includeOutput?: string[];
}

// ── Capability Explanation Config ──
export interface CapabilityExplanationConfig {
  enabled?: boolean;
  summary?: string;
}

// ── MCP exposure (agent surface) ──
export type CapabilityExposeAs = 'mcp';

export interface McpExposureConfig {
  /** Agent-facing description override for MCP manifest and skills */
  description?: string;
  /** Maps to MCP annotations.destructiveHint */
  dangerous?: boolean;
  /** Categorization hints for tool selection (manifest + skills) */
  agentTags?: readonly string[];
}

// ── Capability Contract ──
export interface CapabilityContract<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  kind: CapabilityKind;
  domain: string;
  description?: string;
  tags?: string[];
  version?: string;
  owner?: string;

  input: TInput;
  output: TOutput;

  access?: AccessPolicy;
  effects: CapabilityEffects;
  audit?: CapabilityAuditConfig;
  explanation?: CapabilityExplanationConfig;
  /** Surfaces this capability is exposed on (e.g. MCP tools) */
  exposeAs?: readonly CapabilityExposeAs[];
  /** MCP-specific metadata when `exposeAs` includes `'mcp'` */
  mcp?: McpExposureConfig;

  handler: (ctx: ExecutionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}
