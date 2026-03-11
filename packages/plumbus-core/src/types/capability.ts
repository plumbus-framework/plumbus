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

  handler: (ctx: ExecutionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}
