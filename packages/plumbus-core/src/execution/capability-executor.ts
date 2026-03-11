import type { z } from "zod";
import { isPlumbusError } from "../errors/index.js";
import type { CapabilityContract } from "../types/capability.js";
import type { ExecutionContext } from "../types/context.js";
import type { PlumbusError } from "../types/errors.js";
import { evaluateAccess } from "./authorization.js";

export interface ExecutionResult<T = unknown> {
  success: true;
  data: T;
}

export interface ExecutionFailure {
  success: false;
  error: PlumbusError;
}

export type CapabilityResult<T = unknown> =
  | ExecutionResult<T>
  | ExecutionFailure;

/**
 * Execute a capability through the full pipeline:
 * 1. Validate input
 * 2. Evaluate access policy
 * 3. Execute handler
 * 4. Validate output
 * 5. Record audit
 */
export async function executeCapability<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  capability: CapabilityContract<TInput, TOutput>,
  ctx: ExecutionContext,
  rawInput: unknown,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  // 1. Validate input against schema
  const inputResult = capability.input.safeParse(rawInput);
  if (!inputResult.success) {
    const error = ctx.errors.validation("Invalid input", {
      capability: capability.name,
      issues: inputResult.error.issues,
    });
    await recordAudit(ctx, capability, "failure", { error });
    return { success: false, error };
  }

  const input = inputResult.data as z.infer<TInput>;

  // 2. Evaluate access policy (deny-by-default)
  const authResult = evaluateAccess(capability.access, ctx.auth);
  if (!authResult.allowed) {
    const error = ctx.errors.forbidden(
      authResult.reason ?? "Access denied",
      { capability: capability.name },
    );
    await recordAudit(ctx, capability, "denied", { error });
    return { success: false, error };
  }

  // 3. Execute handler
  let rawOutput: z.infer<TOutput>;
  try {
    rawOutput = await capability.handler(ctx, input);
  } catch (err) {
    // If the handler threw a PlumbusError, surface it directly
    if (isPlumbusError(err)) {
      await recordAudit(ctx, capability, "failure", { error: err });
      return { success: false, error: err };
    }
    const error = ctx.errors.internal("Capability execution failed", {
      capability: capability.name,
      message: err instanceof Error ? err.message : String(err),
    });
    ctx.logger.error(`Capability "${capability.name}" threw an error`, {
      error: err instanceof Error ? err.message : String(err),
    });
    await recordAudit(ctx, capability, "failure", { error });
    return { success: false, error };
  }

  // 4. Validate output against schema
  const outputResult = capability.output.safeParse(rawOutput);
  if (!outputResult.success) {
    const error = ctx.errors.internal("Invalid output from capability", {
      capability: capability.name,
      issues: outputResult.error.issues,
    });
    ctx.logger.error(
      `Capability "${capability.name}" returned invalid output`,
      { issues: outputResult.error.issues },
    );
    await recordAudit(ctx, capability, "failure", { error });
    return { success: false, error };
  }

  // 5. Record success audit
  await recordAudit(ctx, capability, "success");

  return { success: true, data: outputResult.data as z.infer<TOutput> };
}

async function recordAudit(
  ctx: ExecutionContext,
  capability: CapabilityContract<any, any>,
  outcome: "success" | "failure" | "denied",
  metadata?: Record<string, unknown>,
): Promise<void> {
  // Skip if audit is explicitly disabled for this capability
  if (capability.audit?.enabled === false) return;

  const auditEvent = capability.audit?.event ?? `capability.${capability.name}`;

  try {
    await ctx.audit.record(auditEvent, {
      capability: capability.name,
      domain: capability.domain,
      kind: capability.kind,
      outcome,
      actor: ctx.auth.userId,
      tenantId: ctx.auth.tenantId,
      ...metadata,
    });
  } catch {
    // Audit failures should not break capability execution
    ctx.logger.error(`Failed to record audit for capability "${capability.name}"`);
  }
}
