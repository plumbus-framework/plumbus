import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';

export interface RetryPolicy {
  /** Total calls including the initial call. */
  maxAttempts?: number;
  backoff?: 'fixed' | 'exponential';
  baseDelayMs?: number;
  maxDelayMs?: number;
}
export const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(1000).optional(),
    backoff: z.enum(['fixed', 'exponential']).optional(),
    baseDelayMs: z.number().finite().nonnegative().optional(),
    maxDelayMs: z.number().finite().nonnegative().optional(),
  })
  .strict();
export function resolveRetryPolicy(
  policy: RetryPolicy | undefined,
  defaults: Required<RetryPolicy>,
): Required<RetryPolicy> {
  const parsed = retryPolicySchema.safeParse(policy ?? {});
  if (!parsed.success)
    throw new DataValidationError('Invalid retry policy', { issues: parsed.error.issues });
  const resolved = { ...defaults, ...parsed.data };
  if (!retryPolicySchema.safeParse(resolved).success)
    throw new DataValidationError('Invalid retry defaults');
  return resolved;
}
export function retryDelay(policy: Required<RetryPolicy>, failedAttempt: number): number {
  return Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs *
      (policy.backoff === 'exponential' ? 2 ** Math.min(failedAttempt - 1, 30) : 1),
  );
}
/** Only explicit classification and structural validation/security errors are permanent. */
export function isPermanentFailure(error: unknown): boolean {
  const parsed = z
    .object({
      code: z.string().optional(),
      metadata: z.object({ retryable: z.boolean().optional() }).passthrough().optional(),
    })
    .passthrough()
    .safeParse(error);
  if (!parsed.success) return false;
  if (parsed.data.metadata?.retryable !== undefined) return !parsed.data.metadata.retryable;
  return ['validation', 'forbidden', 'unauthorized', 'dependencyViolation'].includes(
    parsed.data.code ?? '',
  );
}

/** A fresh job claim belongs to another worker; retain the delivery for later. */
export function isDeferredDelivery(error: unknown): boolean {
  return z.object({ metadata: z.object({ deliveryDeferred: z.literal(true) }) }).safeParse(error)
    .success;
}
