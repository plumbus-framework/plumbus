import type { z } from 'zod';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext } from '../types/context.js';
import type { CapabilityKind } from '../types/enums.js';
import type { AccessPolicy } from '../types/security.js';

/** Duck-type check for Zod schemas (works across different Zod instances) */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in value &&
    'safeParse' in value &&
    typeof (value as Record<string, unknown>).safeParse === 'function'
  );
}

interface DefineCapabilityInput<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
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
  effects: {
    data: string[];
    events: string[];
    external: string[];
    flows?: string[];
    ai: boolean;
  };
  audit?: {
    enabled?: boolean;
    event: string;
    includeInput?: string[];
    includeOutput?: string[];
  };
  explanation?: {
    enabled?: boolean;
    summary?: string;
  };

  handler: (ctx: ExecutionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

export function defineCapability<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  config: DefineCapabilityInput<TInput, TOutput>,
): CapabilityContract<TInput, TOutput> {
  if (!config.name) {
    throw new Error('Capability name is required');
  }
  if (!config.kind) {
    throw new Error('Capability kind is required');
  }
  if (!config.domain) {
    throw new Error('Capability domain is required');
  }
  if (!isZodSchema(config.input)) {
    throw new Error(`Capability "${config.name}": input must be a Zod schema`);
  }
  if (!isZodSchema(config.output)) {
    throw new Error(`Capability "${config.name}": output must be a Zod schema`);
  }
  if (!config.effects) {
    throw new Error(`Capability "${config.name}": effects declaration is required`);
  }
  if (typeof config.handler !== 'function') {
    throw new Error(`Capability "${config.name}": handler function is required`);
  }

  return Object.freeze({ ...config });
}
