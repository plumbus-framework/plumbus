import type { EntityDefinition } from '../types/entity.js';
import type { FieldClassification } from '../types/enums.js';

const SENSITIVE_CLASSIFICATIONS = new Set<FieldClassification>([
  'sensitive',
  'highly_sensitive',
  'personal',
]);

/**
 * Field names that should be masked in audit logs and structured log metadata,
 * based on `maskedInLogs` or sensitive field classifications.
 */
export function getMaskedFields(entity: EntityDefinition): string[] {
  const masked: string[] = [];

  for (const [name, descriptor] of Object.entries(entity.fields)) {
    const opts = descriptor.options;
    if (opts.maskedInLogs) {
      masked.push(name);
    } else if (opts.classification && SENSITIVE_CLASSIFICATIONS.has(opts.classification)) {
      masked.push(name);
    }
  }
  return masked;
}

/** Field names whose changes alone are not worth an audit record (`auditSilent: true`). */
export function getAuditSilentFields(entity: EntityDefinition): string[] {
  return Object.entries(entity.fields)
    .filter(([, descriptor]) => descriptor.options.auditSilent === true)
    .map(([name]) => name);
}

/** Token substituted for redacted structured log metadata. */
export const LOG_MASK_TOKEN = '***MASKED***';

/** Token substituted for redacted audit-record field values (stored-data compat). */
export const AUDIT_MASK_TOKEN = '***';

/**
 * Deep-mask values whose keys appear in `maskKeys` (top-level or nested objects).
 */
export function maskSensitiveValues(
  value: unknown,
  maskKeys: string[],
  token: string = LOG_MASK_TOKEN,
): unknown {
  if (!maskKeys.length) return value;
  const keySet = new Set(maskKeys);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => maskSensitiveValues(entry, maskKeys, token));
  }
  const record = value as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    masked[key] = keySet.has(key) ? token : maskSensitiveValues(entry, maskKeys, token);
  }
  return masked;
}

/** Collect unique masked field names across all registered entities. */
export function collectMaskedFieldsFromEntities(entities: EntityDefinition[]): string[] {
  const names = new Set<string>();
  for (const entity of entities) {
    for (const field of getMaskedFields(entity)) {
      names.add(field);
    }
  }
  return Array.from(names);
}
