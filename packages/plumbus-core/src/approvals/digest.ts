import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 of canonical JSON. Approval bindings use this as the input digest. */
export function digestApprovalInput(input: unknown): string {
  const json = JSON.stringify(sortKeys(input));
  return createHash('sha256').update(json).digest('hex');
}
