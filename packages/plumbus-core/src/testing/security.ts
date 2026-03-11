// ── Security Test Helpers ──
// Assertion utilities for testing authorization, tenant isolation,
// access policies, and field masking.

import type { z } from "zod";
import { evaluateAccess } from "../execution/authorization.js";
import type { CapabilityResult } from "../execution/capability-executor.js";
import type { CapabilityContract } from "../types/capability.js";
import type { AccessPolicy, AuthContext } from "../types/security.js";
import { createTestAuth, type TestContextOptions } from "./context.js";
import { runCapability } from "./run-capability.js";

// ── Access Policy Assertions ──

export interface AccessTestResult {
  allowed: boolean;
  reason?: string;
}

/** Assert that a given auth context IS allowed by an access policy */
export function assertAccessAllowed(
  policy: AccessPolicy | undefined,
  auth: AuthContext,
): void {
  const result = evaluateAccess(policy, auth);
  if (!result.allowed) {
    throw new Error(
      `Expected access to be ALLOWED but was DENIED.\n` +
      `  Reason: ${result.reason}\n` +
      `  Auth: userId=${auth.userId}, roles=[${auth.roles.join(",")}], tenantId=${auth.tenantId}`,
    );
  }
}

/** Assert that a given auth context IS denied by an access policy */
export function assertAccessDenied(
  policy: AccessPolicy | undefined,
  auth: AuthContext,
): void {
  const result = evaluateAccess(policy, auth);
  if (result.allowed) {
    throw new Error(
      `Expected access to be DENIED but was ALLOWED.\n` +
      `  Auth: userId=${auth.userId}, roles=[${auth.roles.join(",")}], tenantId=${auth.tenantId}`,
    );
  }
}

// ── Capability Authorization Assertions ──

/**
 * Assert a capability denies access for a given auth context.
 * Executes the capability pipeline and asserts a "forbidden" error.
 */
export async function assertCapabilityDenied<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  capability: CapabilityContract<TInput, TOutput>,
  input: unknown,
  options?: TestContextOptions,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  const result = await runCapability(capability, input, options);
  if (result.success) {
    throw new Error(
      `Expected capability "${capability.name}" to DENY access but it SUCCEEDED`,
    );
  }
  if (result.error.code !== "forbidden") {
    throw new Error(
      `Expected "forbidden" error but got "${result.error.code}": ${result.error.message}`,
    );
  }
  return result;
}

/**
 * Assert a capability allows access for a given auth context.
 * Executes the capability pipeline and asserts success.
 */
export async function assertCapabilityAllowed<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  capability: CapabilityContract<TInput, TOutput>,
  input: unknown,
  options?: TestContextOptions,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  const result = await runCapability(capability, input, options);
  if (!result.success && result.error.code === "forbidden") {
    throw new Error(
      `Expected capability "${capability.name}" to ALLOW access but got forbidden: ${result.error.message}`,
    );
  }
  return result;
}

// ── Cross-Tenant Isolation Test ──

/**
 * Assert that a tenant-scoped capability denies access to users from a different tenant.
 * Runs the capability twice: once with matching tenant (should succeed), once with mismatched tenant (should deny).
 */
export async function assertTenantIsolation<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  capability: CapabilityContract<TInput, TOutput>,
  input: unknown,
  tenantId: string,
  options?: TestContextOptions,
): Promise<{ sameTenantResult: CapabilityResult; crossTenantResult: CapabilityResult }> {
  const sameTenantResult = await runCapability(capability, input, {
    ...options,
    auth: { ...options?.auth, tenantId, roles: ["admin"] },
  });

  const crossTenantResult = await runCapability(capability, input, {
    ...options,
    auth: { ...options?.auth, tenantId: `other-${tenantId}`, roles: ["admin"] },
  });

  return { sameTenantResult, crossTenantResult };
}

// ── Plumbus Error Assertions ──

/** Assert a capability result is a validation error */
export function assertValidationError(result: CapabilityResult): void {
  if (result.success) {
    throw new Error("Expected validation error but capability succeeded");
  }
  if (result.error.code !== "validation") {
    throw new Error(
      `Expected "validation" error but got "${result.error.code}": ${result.error.message}`,
    );
  }
}

/** Assert a capability result is a specific error code */
export function assertPlumbusError(
  result: CapabilityResult,
  expectedCode: string,
): void {
  if (result.success) {
    throw new Error(`Expected "${expectedCode}" error but capability succeeded`);
  }
  if (result.error.code !== expectedCode) {
    throw new Error(
      `Expected "${expectedCode}" error but got "${result.error.code}": ${result.error.message}`,
    );
  }
}

// ── Auth Scenario Builders ──

/** Create an unauthenticated auth context (no roles, no tenant) */
export function unauthenticated(): AuthContext {
  return createTestAuth({ userId: undefined, roles: [], tenantId: undefined });
}

/** Create an admin auth context */
export function adminAuth(tenantId?: string): AuthContext {
  return createTestAuth({ userId: "admin-user", roles: ["admin"], tenantId });
}

/** Create a service account auth context */
export function serviceAccountAuth(accountId: string): AuthContext {
  return createTestAuth({
    userId: accountId,
    roles: [],
    provider: "service-account",
  });
}
