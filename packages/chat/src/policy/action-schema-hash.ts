import { createHash } from 'node:crypto';

/** Legacy payload hash (pre-v2 pending rows). */
export function legacyActionSchemaHash(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex');
}

/**
 * v2 hash binds both the capability input schema and the proposed payload.
 * Wire format: `v2:` + sha256(schema + NUL + payload).
 */
export function capabilityActionHashV2(
  inputSchema: Record<string, unknown>,
  input: unknown,
): string {
  const body = createHash('sha256')
    .update(JSON.stringify(inputSchema))
    .update('\0')
    .update(JSON.stringify(input))
    .digest('hex');
  return `v2:${body}`;
}

/** @deprecated Use capabilityActionHashV2 — schema-only hashes are not payload-bound. */
export function capabilityInputSchemaHashV2(inputSchema: Record<string, unknown>): string {
  const body = createHash('sha256').update(JSON.stringify(inputSchema)).digest('hex');
  return `v2:${body}`;
}

export function isV2SchemaHash(hash: string): boolean {
  return hash.startsWith('v2:');
}
