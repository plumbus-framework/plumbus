import type { z } from 'zod';

/**
 * "Any schema", with `any` input and output, as zod 3's `z.ZodTypeAny` was. zod 4's
 * `z.ZodTypeAny` infers `unknown`, so a bare `CapabilityContract` (or flow, prompt, event)
 * would no longer accept a handler typed for its own schema; collections of definitions
 * (`capabilities: CapabilityContract[]`) depend on that.
 */
// biome-ignore lint/suspicious/noExplicitAny: this is the any-typed schema the defaults mean.
export type AnyZodSchema = z.ZodType<any, any>;
