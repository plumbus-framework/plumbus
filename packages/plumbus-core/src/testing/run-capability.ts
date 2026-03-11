// ── Capability Test Runner ──
// Execute a capability in an isolated test environment without requiring
// a real server, auth middleware, or database.

import type { z } from "zod";
import {
    executeCapability,
    type CapabilityResult,
} from "../execution/capability-executor.js";
import type { CapabilityContract } from "../types/capability.js";
import type { ExecutionContext } from "../types/context.js";
import { createTestContext, type TestContextOptions } from "./context.js";

export interface RunCapabilityOptions extends TestContextOptions {
  /** Provide a pre-built context instead of building one from options */
  ctx?: ExecutionContext;
}

/**
 * Execute a capability in a test environment.
 *
 * Usage:
 * ```ts
 * const result = await runCapability(myCapability, { id: "123" });
 * if (result.success) expect(result.data).toEqual(...);
 * ```
 */
export async function runCapability<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  capability: CapabilityContract<TInput, TOutput>,
  input: unknown,
  options?: RunCapabilityOptions,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  const ctx = options?.ctx ?? createTestContext(options);
  return executeCapability(capability, ctx, input);
}
