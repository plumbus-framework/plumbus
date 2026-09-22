import { z } from '@plumbus/core/zod';

export const secretEnvSchema = z.object({ env: z.string().min(1) }).strict();
export const secretLiteralSchema = z.object({ literal: z.string() }).strict();

export const secretSourceSchema = z.union([
  z.string(),
  secretEnvSchema,
  secretLiteralSchema,
  z.function().returns(z.promise(z.string())),
]);

export type SecretSource = z.infer<typeof secretSourceSchema>;

export async function resolveSecretSource(source: SecretSource): Promise<string> {
  if (typeof source === 'string') {
    return source;
  }
  if (typeof source === 'function') {
    return source();
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
