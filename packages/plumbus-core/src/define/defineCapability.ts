import { z } from 'zod';
import type { CapabilityContract, McpExposureConfig } from '../types/capability.js';
import type { ExecutionContext } from '../types/context.js';
import type { CapabilityKind } from '../types/enums.js';
import { deepFreeze } from '../types/deep-freeze.js';
import { isMcpExposed } from '../mcp/exposure.js';
import type { AccessPolicy } from '../types/security.js';
import { throwDefineValidationError } from './validation-error.js';

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
  exposeAs?: readonly 'mcp'[];
  mcp?: McpExposureConfig;

  handler: (ctx: ExecutionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

const McpExposureConfigSchema = z
  .object({
    description: z.string().optional(),
    dangerous: z.boolean().optional(),
    agentTags: z.array(z.string()).optional(),
  })
  .strict();

const ExposeAsSchema = z.array(z.enum(['mcp'])).optional();

function hasAgentFacingDescription(
  config: DefineCapabilityInput<z.ZodTypeAny, z.ZodTypeAny>,
): boolean {
  const summary = config.explanation?.summary;
  if (typeof summary === 'string' && summary.length > 0) {
    return true;
  }
  if (typeof config.description === 'string' && config.description.length > 0) {
    return true;
  }
  const mcpDesc = config.mcp?.description;
  return typeof mcpDesc === 'string' && mcpDesc.length > 0;
}

function validateMcpExposure(config: DefineCapabilityInput<z.ZodTypeAny, z.ZodTypeAny>): void {
  const draft = { exposeAs: config.exposeAs, mcp: config.mcp } as CapabilityContract;
  if (!isMcpExposed(draft)) {
    return;
  }

  if (config.kind === 'eventHandler') {
    throwDefineValidationError(
      `Capability "${config.name}": eventHandler cannot be exposed via MCP`,
      { field: 'exposeAs' },
    );
  }
  if (config.kind === 'job') {
    throwDefineValidationError(`Capability "${config.name}": job cannot be exposed via MCP`, {
      field: 'exposeAs',
    });
  }
  if (!hasAgentFacingDescription(config)) {
    throwDefineValidationError(
      `Capability "${config.name}": MCP-exposed capabilities require description, mcp.description, or explanation.summary`,
      { field: 'mcp' },
    );
  }
  if (config.exposeAs !== undefined) {
    const exposeResult = ExposeAsSchema.safeParse(config.exposeAs);
    if (!exposeResult.success) {
      throwDefineValidationError(`Capability "${config.name}": invalid exposeAs`, {
        field: 'exposeAs',
      });
    }
  }
  if (config.mcp !== undefined) {
    const mcpResult = McpExposureConfigSchema.safeParse(config.mcp);
    if (!mcpResult.success) {
      throwDefineValidationError(`Capability "${config.name}": invalid mcp config`, {
        field: 'mcp',
      });
    }
  }
}

export function defineCapability<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  config: DefineCapabilityInput<TInput, TOutput>,
): CapabilityContract<TInput, TOutput> {
  if (!config.name) {
    throwDefineValidationError('Capability name is required', { field: 'name' });
  }
  if (!config.kind) {
    throwDefineValidationError('Capability kind is required', { field: 'kind' });
  }
  if (!config.domain) {
    throwDefineValidationError('Capability domain is required', { field: 'domain' });
  }
  if (!isZodSchema(config.input)) {
    throwDefineValidationError(`Capability "${config.name}": input must be a Zod schema`, {
      field: 'input',
    });
  }
  if (!isZodSchema(config.output)) {
    throwDefineValidationError(`Capability "${config.name}": output must be a Zod schema`, {
      field: 'output',
    });
  }
  if (!config.effects) {
    throwDefineValidationError(`Capability "${config.name}": effects declaration is required`, {
      field: 'effects',
    });
  }
  if (typeof config.handler !== 'function') {
    throwDefineValidationError(`Capability "${config.name}": handler function is required`, {
      field: 'handler',
    });
  }

  validateMcpExposure(config as unknown as DefineCapabilityInput<z.ZodTypeAny, z.ZodTypeAny>);

  return deepFreeze({ ...config });
}
