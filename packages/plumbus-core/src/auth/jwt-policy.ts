import { z } from 'zod';

const secretSchema = z.string().refine((secret) => {
  const value = secret.trim();
  return (
    value.length >= 32 &&
    !['development-secret', 'development-secret-placeholder-32chars-min'].includes(value)
  );
});

/** Reject known shared defaults and short/padded HMAC keys in every environment. */
export function isValidJwtSecret(secret: unknown): secret is string {
  return secretSchema.safeParse(secret).success;
}
