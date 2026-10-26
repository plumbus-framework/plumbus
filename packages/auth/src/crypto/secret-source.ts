import { z } from '@plumbus/core/zod';

export const secretEnvSchema = z.object({ env: z.string().min(1) }).strict();
export const secretLiteralSchema = z.object({ literal: z.string() }).strict();

export const secretSourceSchema = z.union([
  z.string(),
  secretEnvSchema,
  secretLiteralSchema,
  // zod 3 wrapped the function to check its result; zod 4's z.function() is not a schema to
  // put in a union, so the result is checked where the function is called.
  z.custom<() => Promise<string>>((value) => typeof value === 'function', 'Expected a function'),
]);

export type SecretSource = z.infer<typeof secretSourceSchema>;

export async function resolveSecretSource(source: SecretSource): Promise<string> {
  if (typeof source === 'string') {
    return source;
  }
  if (typeof source === 'function') {
    const value: unknown = await source();
    if (typeof value !== 'string') {
      throw new Error('A secret source function must resolve to a string');
    }
    return value;
  }
  if ('env' in source) {
    const value = process.env[source.env];
    if (value === undefined || value === '') {
      throw new Error(`Environment variable "${source.env}" is not set or empty`);
    }
    return value;
  }
  if ('literal' in source) {
    return source.literal;
  }
  throw new Error('Invalid secret source');
}
