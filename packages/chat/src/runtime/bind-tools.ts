// packages/chat/src/runtime/bind-tools.ts
import { createHash } from 'node:crypto';
import type { AITool, CapabilityContract, ExecutionContext } from '@plumbus/core';
import { zodToProviderJsonSchema } from '@plumbus/core';
import type { z } from '@plumbus/core/zod';
import { capabilityInputSchemaHashV2 } from '../policy/action-schema-hash.js';
import { isConfirmCapability } from './tool-effects.js';

export type BoundToolKind = 'capability' | 'flow';
export type BoundToolMode = 'auto' | 'confirm';

export interface ChatToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface BoundChatTool {
  tool: AITool;
  kind: BoundToolKind;
  mode: BoundToolMode;
  targetName: string;
  /**
   * C4: capability version from CapabilityContract.version when present; otherwise the
   * input-schema hash FALLBACK. For flows, targetVersion is the flow input-schema hash.
   */
  targetVersion: string;
  annotations: ChatToolAnnotations;
  inputSchemaHash: string;
  toolBindingHash: string;
}

export interface ChatToolPresentation {
  label?: {
    default: string;
    translationKey?: string;
  };
  confirmation?: {
    schema: z.ZodType<unknown>;
    project(args: { input: unknown; ctx: ExecutionContext }): unknown | Promise<unknown>;
  };
  result?: {
    schema: z.ZodType<unknown>;
    project(args: { result: unknown; ctx: ExecutionContext }): unknown | Promise<unknown>;
  };
}

/** Thrown during binding; `code` is a member of the chat.* error vocabulary (Appendix A.10). */
export class ChatToolBindError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatToolBindError';
    this.code = code;
  }
}

/** C9: portable tool-name grammar. */
const PORTABLE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function validateToolName(name: string): void {
  if (name.startsWith('flow__')) {
    throw new ChatToolBindError(
      'chat.tool_name_invalid',
      `Capability tool name "${name}" must not use the reserved flow__ prefix`,
    );
  }
  if (!PORTABLE_TOOL_NAME.test(name)) {
    throw new ChatToolBindError(
      'chat.tool_name_invalid',
      `Tool name "${name}" violates ^[A-Za-z][A-Za-z0-9_-]{0,63}$`,
    );
  }
}

function buildAnnotations(cap: CapabilityContract, mode: BoundToolMode): ChatToolAnnotations {
  const e = cap.effects;
  const hasExternal = e.external.length > 0;
  return {
    readOnlyHint: mode === 'auto',
    destructiveHint: mode === 'confirm' && (e.data.length > 0 || hasExternal),
    idempotentHint: false,
    openWorldHint: hasExternal,
  };
}

function computeBindingHash(parts: {
  kind: BoundToolKind;
  targetName: string;
  targetVersion: string;
  mode: BoundToolMode;
  inputSchemaHash: string;
}): string {
  const body = createHash('sha256')
    .update(
      [parts.kind, parts.targetName, parts.targetVersion, parts.mode, parts.inputSchemaHash].join(
        '\0',
      ),
    )
    .digest('hex');
  return `tb1:${body}`;
}

/**
 * Resolve configured capability names to bound provider tools. Confirm-mode tools
 * are included in the returned list (so Stage 4 can present + execute them); the
 * Stage 3 tool phase itself only presents mode==='auto' tools to the provider.
 */
export function bindChatCapabilityTools(
  ctx: ExecutionContext,
  capabilityNames: string[],
  opts: { maxTools: number },
): BoundChatTool[] {
  const resolve = ctx.__runtime?.resolveCapability;
  if (!resolve) {
    throw new ChatToolBindError(
      'chat.tools_runtime_unavailable',
      'ctx.__runtime.resolveCapability is unavailable at bind time',
    );
  }

  const names = capabilityNames.slice(0, opts.maxTools);
  if (capabilityNames.length > opts.maxTools) {
    console.warn(
      `[@plumbus/chat] bindChatCapabilityTools: ${capabilityNames.length} capabilities configured; capping to maxTools=${opts.maxTools}`,
    );
  }

  const bound: BoundChatTool[] = [];
  for (const name of names) {
    validateToolName(name);
    const cap = resolve(name);
    if (!cap) {
      throw new ChatToolBindError(
        'chat.tool_unknown_capability',
        `Configured capability "${name}" cannot be resolved`,
      );
    }
    const { schema } = zodToProviderJsonSchema(cap.input, { promptName: name });
    const inputSchemaHash = capabilityInputSchemaHashV2(schema);
    const mode: BoundToolMode = isConfirmCapability(cap) ? 'confirm' : 'auto';
    const targetVersion = cap.version ?? inputSchemaHash;
    const tool: AITool = {
      name,
      description: cap.description ?? name,
      parameters: schema,
    };
    bound.push({
      tool,
      kind: 'capability',
      mode,
      targetName: name,
      targetVersion,
      annotations: buildAnnotations(cap, mode),
      inputSchemaHash,
      toolBindingHash: computeBindingHash({
        kind: 'capability',
        targetName: name,
        targetVersion,
        mode,
        inputSchemaHash,
      }),
    });
  }
  return bound;
}

/**
 * Resolve a single tool binding for confirm-time hash recompute (Stage 5 /confirm route).
 */
export async function resolveToolBinding(
  ctx: ExecutionContext,
  kind: BoundToolKind,
  targetName: string,
): Promise<
  { ok: true; inputSchemaHash: string; toolBindingHash: string } | { ok: false; code: string }
> {
  if (kind === 'flow') {
    return { ok: false, code: 'chat.tool_unknown_capability' };
  }
  const resolve = ctx.__runtime?.resolveCapability;
  if (!resolve) {
    return { ok: false, code: 'chat.tools_runtime_unavailable' };
  }
  const cap = resolve(targetName);
  if (!cap) {
    return { ok: false, code: 'chat.tool_unknown_capability' };
  }
  const { schema } = zodToProviderJsonSchema(cap.input, { promptName: targetName });
  const inputSchemaHash = capabilityInputSchemaHashV2(schema);
  const mode: BoundToolMode = isConfirmCapability(cap) ? 'confirm' : 'auto';
  const targetVersion = cap.version ?? inputSchemaHash;
  return {
    ok: true,
    inputSchemaHash,
    toolBindingHash: computeBindingHash({
      kind: 'capability',
      targetName,
      targetVersion,
      mode,
      inputSchemaHash,
    }),
  };
}

// ── Flow tool binding (Stage 6) ──

const FLOW_TOOL_PREFIX = 'flow__';
/** C9: portable, provider-safe tool-name grammar; total length <= 64. */
const FLOW_PORTABLE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Schema-only version/binding hash (C4): `v2:` + sha256(input JSON Schema). */
function flowInputSchemaHash(inputSchema: Record<string, unknown>): string {
  return `v2:${createHash('sha256').update(JSON.stringify(inputSchema)).digest('hex')}`;
}

function flowToolBindingHash(parts: {
  providerToolName: string;
  targetName: string;
  targetVersion: string;
  inputSchemaHash: string;
  mode: 'auto' | 'confirm';
}): string {
  const body = createHash('sha256')
    .update(
      JSON.stringify([
        'flow',
        parts.providerToolName,
        parts.targetName,
        parts.targetVersion,
        parts.inputSchemaHash,
        parts.mode,
      ]),
    )
    .digest('hex');
  return `v1:${body}`;
}

export type BindFlowToolResult =
  | { ok: true; bound: BoundChatTool }
  | { ok: false; flowName: string; code: string; message: string };

/**
 * Bind a single registered flow as an AUTO provider tool named
 * `flow__<flowName>`. Flow tools are never bound in confirm mode.
 */
export function bindFlowTool(ctx: ExecutionContext, flowName: string): BindFlowToolResult {
  if (typeof ctx.flows.describe !== 'function') {
    return {
      ok: false,
      flowName,
      code: 'chat.tools_flows_unavailable',
      message: `Flow describe service is unavailable; cannot bind flow "${flowName}".`,
    };
  }

  const desc = ctx.flows.describe(flowName);
  if (!desc) {
    return {
      ok: false,
      flowName,
      code: 'chat.tool_unknown_flow',
      message: `Flow "${flowName}" is not registered.`,
    };
  }

  const providerToolName = `${FLOW_TOOL_PREFIX}${flowName}`;
  if (flowName.length > 57 || !FLOW_PORTABLE_TOOL_NAME.test(providerToolName)) {
    return {
      ok: false,
      flowName,
      code: 'chat.tool_name_invalid',
      message: `Flow tool name "${providerToolName}" violates the portable tool-name grammar (flow names must be <= 57 chars and match [A-Za-z0-9_-]).`,
    };
  }

  if (!desc.parameters) {
    return {
      ok: false,
      flowName,
      code: 'chat.tool_flow_schema_invalid',
      message: `Flow "${flowName}" input schema cannot be exposed as a provider tool.`,
    };
  }

  const inputSchemaHash = flowInputSchemaHash(desc.inputSchema);
  // C4: flows have no `version` field → the input-schema hash IS the targetVersion.
  const targetVersion = inputSchemaHash;

  const tool: AITool = {
    name: providerToolName,
    description: desc.description ?? `Start the "${flowName}" flow.`,
    parameters: desc.parameters,
  };

  const bound: BoundChatTool = {
    tool,
    kind: 'flow',
    mode: 'auto', // flow tools are ALWAYS auto (never confirm)
    targetName: flowName,
    targetVersion,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaHash,
    toolBindingHash: flowToolBindingHash({
      providerToolName,
      targetName: flowName,
      targetVersion,
      inputSchemaHash,
      mode: 'auto',
    }),
  };

  return { ok: true, bound };
}

/** Bind every flow name in `autoStartFlows`, collecting per-flow bind errors. */
export function bindFlowTools(
  ctx: ExecutionContext,
  flowNames: readonly string[],
): { tools: BoundChatTool[]; errors: Array<{ flowName: string; code: string; message: string }> } {
  const tools: BoundChatTool[] = [];
  const errors: Array<{ flowName: string; code: string; message: string }> = [];
  for (const flowName of flowNames) {
    const result = bindFlowTool(ctx, flowName);
    if (result.ok) tools.push(result.bound);
    else errors.push({ flowName: result.flowName, code: result.code, message: result.message });
  }
  return { tools, errors };
}
