// ── AI Security Boundaries ──
// Detect classified fields in prompt inputs, warn or redact sensitive data

import type { EntityDefinition } from '../types/entity.js';
import type { FieldClassification } from '../types/enums.js';

// ── Security Check Result ──
export interface SecurityCheckResult {
  safe: boolean;
  warnings: SecurityWarning[];
  redactedInput?: Record<string, unknown>;
}

export interface SecurityWarning {
  field: string;
  classification: FieldClassification;
  entity?: string;
  message: string;
}

// ── Classification thresholds ──
const CLASSIFICATION_ORDER: FieldClassification[] = [
  'public',
  'internal',
  'personal',
  'sensitive',
  'highly_sensitive',
];

export interface AISecurityConfig {
  /** Minimum classification level that triggers a warning (default: "sensitive") */
  warnThreshold?: FieldClassification;
  /** Minimum classification level that triggers automatic redaction (default: "highly_sensitive") */
  redactThreshold?: FieldClassification;
  /** Registered entity definitions to cross-reference field names */
  entities?: EntityDefinition[];
}

function classificationLevel(c: FieldClassification): number {
  return CLASSIFICATION_ORDER.indexOf(c);
}

/**
 * Build a map of field name → highest classification from entity definitions
 */
function buildFieldClassificationMap(
  entities: EntityDefinition[],
): Map<string, { classification: FieldClassification; entity: string }> {
  const map = new Map<string, { classification: FieldClassification; entity: string }>();
  for (const entity of entities) {
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      const cls = descriptor.options?.classification;
      if (!cls) continue;
      const existing = map.get(fieldName);
      if (!existing || classificationLevel(cls) > classificationLevel(existing.classification)) {
        map.set(fieldName, { classification: cls, entity: entity.name });
      }
    }
  }
  return map;
}

/**
 * Check prompt input values against known field classifications.
 * Recursively scans nested objects for sensitive fields.
 * Returns warnings for sensitive data and optionally redacts.
 */
export function checkPromptSecurity(
  input: Record<string, unknown>,
  config?: AISecurityConfig,
): SecurityCheckResult {
  const warnLevel = classificationLevel(config?.warnThreshold ?? 'sensitive');
  const redactLevel = classificationLevel(config?.redactThreshold ?? 'highly_sensitive');
  const entities = config?.entities ?? [];

  const fieldMap = buildFieldClassificationMap(entities);
  const warnings: SecurityWarning[] = [];
  const redactedInput = structuredClone(input);
  let needsRedaction = false;

  function scanObject(
    obj: Record<string, unknown>,
    redactTarget: Record<string, unknown>,
    path: string,
  ): void {
    for (const key of Object.keys(obj)) {
      const fieldInfo = fieldMap.get(key);
      const fullPath = path ? `${path}.${key}` : key;

      if (fieldInfo) {
        const level = classificationLevel(fieldInfo.classification);

        if (level >= warnLevel) {
          warnings.push({
            field: fullPath,
            classification: fieldInfo.classification,
            entity: fieldInfo.entity,
            message: `Field "${fullPath}" has classification "${fieldInfo.classification}" (from entity "${fieldInfo.entity}") — included in AI prompt input`,
          });
        }

        if (level >= redactLevel) {
          redactTarget[key] = '[REDACTED]';
          needsRedaction = true;
        }
      }

      // Recurse into nested objects
      const value = obj[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        scanObject(
          value as Record<string, unknown>,
          redactTarget[key] as Record<string, unknown>,
          fullPath,
        );
      }
    }
  }

  scanObject(input, redactedInput, '');

  return {
    safe: warnings.length === 0,
    warnings,
    redactedInput: needsRedaction ? redactedInput : undefined,
  };
}
