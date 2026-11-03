import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// No baggage, identity, exception or request fields enter this contract.
const carrierSchema = z
  .string()
  .length(55)
  .regex(/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-[a-f0-9]{2}$/);
const completedSchema = z.object({
  traceparent: carrierSchema,
  parentSpanId: z
    .string()
    .length(16)
    .regex(/^(?!0{16}$)[a-f0-9]{16}$/),
  kind: z.enum(['request', 'capability', 'worker_step']),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,159}(?![\s\S])/),
  startedAt: z.string().datetime(),
  durationMs: z.number().finite().nonnegative(),
  outcome: z.enum(['ok', 'error', 'refused', 'cancelled']),
  code: z
    .enum([
      'internal',
      'validation',
      'forbidden',
      'unauthorized',
      'notFound',
      'conflict',
      'cancelled',
    ])
    .optional(),
});
export type CompletedTelemetrySpan = Readonly<z.infer<typeof completedSchema>>;
export type TelemetrySpanHook = (span: CompletedTelemetrySpan) => void | Promise<void>;

/** Only standard opaque W3C ids and flags; invalid and legacy carriers stay absent. */
export function validatedTraceparent(value: unknown): string | undefined {
  const parsed = carrierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Derive a real child without resampling. Hook delivery never delays the work. */
export function startTelemetrySpan(
  parent: unknown,
  kind: CompletedTelemetrySpan['kind'],
  name: string,
  hook?: TelemetrySpanHook,
) {
  const valid = validatedTraceparent(parent);
  const parts = valid?.split('-');
  const traceparent = parts
    ? `00-${parts[1]}-${randomBytes(8).toString('hex')}-${parts[3]}`
    : undefined;
  const sampled = parts && (Number.parseInt(parts[3] ?? '00', 16) & 1) === 1;
  const startedAt = hook && sampled ? new Date().toISOString() : undefined;
  const started = hook && sampled ? performance.now() : 0;
  let ended = false;
  return {
    traceparent,
    finish(outcome: CompletedTelemetrySpan['outcome'], code?: unknown) {
      if (ended) return;
      ended = true;
      if (!hook || !sampled) return;
      const safeCode = completedSchema.shape.code.safeParse(code);
      const parsed = completedSchema.safeParse({
        traceparent,
        parentSpanId: parts?.[2],
        kind,
        name,
        startedAt,
        durationMs: performance.now() - started,
        outcome,
        ...(safeCode.success && safeCode.data !== undefined ? { code: safeCode.data } : {}),
      });
      if (!parsed.success) return;
      try {
        void Promise.resolve(hook(Object.freeze(parsed.data))).catch(() => {});
      } catch {
        /* diagnostics never change execution */
      }
    },
  };
}
