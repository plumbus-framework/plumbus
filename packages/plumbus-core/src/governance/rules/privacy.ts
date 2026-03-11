// ── Built-in Privacy Governance Rules ──

import { FieldClassification, GovernanceSeverity } from "../../types/enums.js";
import type { GovernanceRule } from "../rule-engine.js";

const sensitiveNamePattern = /email|password|ssn|social_security|credit_card|phone|address|dob|date_of_birth|name|salary|medical|health|tax|bank/i;

/** Highly_sensitive fields stored unencrypted */
export const ruleSensitiveFieldUnencrypted: GovernanceRule = {
  id: "privacy.sensitive-field-unencrypted",
  category: "privacy",
  severity: GovernanceSeverity.High,
  description: "Sensitive and highly_sensitive fields must be encrypted",
  evaluate(inventory) {
    const highClassifications: FieldClassification[] = [
      FieldClassification.Sensitive,
      FieldClassification.HighlySensitive,
    ];
    return inventory.entities.flatMap((entity) =>
      Object.entries(entity.fields)
        .filter(
          ([, fieldDef]) =>
            fieldDef.options.classification &&
            highClassifications.includes(fieldDef.options.classification) &&
            !fieldDef.options.encrypted,
        )
        .map(([fieldName, fieldDef]) => ({
          severity: GovernanceSeverity.High,
          rule: "privacy.sensitive-field-unencrypted",
          description: `Entity "${entity.name}" field "${fieldName}" is classified as ${fieldDef.options.classification} but not encrypted`,
          affectedComponent: `entity:${entity.name}.${fieldName}`,
          remediation: "Add `encrypted: true` to the field definition",
        })),
    );
  },
};

/** Personal data in logs (not masked) */
export const rulePersonalDataInLogs: GovernanceRule = {
  id: "privacy.personal-data-in-logs",
  category: "privacy",
  severity: GovernanceSeverity.Warning,
  description: "Personal and sensitive fields should be masked in logs",
  evaluate(inventory) {
    const loggableClassifications: FieldClassification[] = [
      FieldClassification.Personal,
      FieldClassification.Sensitive,
      FieldClassification.HighlySensitive,
    ];
    return inventory.entities.flatMap((entity) =>
      Object.entries(entity.fields)
        .filter(
          ([, fieldDef]) =>
            fieldDef.options.classification &&
            loggableClassifications.includes(fieldDef.options.classification) &&
            !fieldDef.options.maskedInLogs,
        )
        .map(([fieldName]) => ({
          severity: GovernanceSeverity.Warning,
          rule: "privacy.personal-data-in-logs",
          description: `Entity "${entity.name}" field "${fieldName}" contains personal/sensitive data but is not masked in logs`,
          affectedComponent: `entity:${entity.name}.${fieldName}`,
          remediation: "Add `maskedInLogs: true` to the field definition",
        })),
    );
  },
};

/** Missing data classification on fields with sensitive-looking names */
export const ruleMissingFieldClassification: GovernanceRule = {
  id: "privacy.missing-field-classification",
  category: "privacy",
  severity: GovernanceSeverity.Warning,
  description: "Fields with sensitive-looking names should have classification metadata",
  evaluate(inventory) {
    return inventory.entities.flatMap((entity) =>
      Object.entries(entity.fields)
        .filter(([fieldName, fieldDef]) => sensitiveNamePattern.test(fieldName) && !fieldDef.options.classification)
        .map(([fieldName]) => ({
          severity: GovernanceSeverity.Warning,
          rule: "privacy.missing-field-classification",
          description: `Entity "${entity.name}" field "${fieldName}" appears sensitive but has no classification`,
          affectedComponent: `entity:${entity.name}.${fieldName}`,
          remediation: `Add classification (e.g., personal, sensitive) to field "${fieldName}"`,
        })),
    );
  },
};

/** Excessive data retention — entities with personal data without retention policies */
export const ruleExcessiveDataRetention: GovernanceRule = {
  id: "privacy.excessive-data-retention",
  category: "privacy",
  severity: GovernanceSeverity.Warning,
  description: "Entities with personal data should define retention policies",
  evaluate(inventory) {
    return inventory.entities
      .filter(
        (entity) =>
          Object.values(entity.fields).some(
            (f) =>
              f.options.classification === FieldClassification.Personal ||
              f.options.classification === FieldClassification.Sensitive ||
              f.options.classification === FieldClassification.HighlySensitive,
          ) && !entity.retention,
      )
      .map((entity) => ({
        severity: GovernanceSeverity.Warning,
        rule: "privacy.excessive-data-retention",
        description: `Entity "${entity.name}" contains personal/sensitive data but has no retention policy`,
        affectedComponent: `entity:${entity.name}`,
        remediation: "Add a retention policy with an appropriate duration",
      }));
  },
};

export const privacyRules: GovernanceRule[] = [
  ruleSensitiveFieldUnencrypted,
  rulePersonalDataInLogs,
  ruleMissingFieldClassification,
  ruleExcessiveDataRetention,
];
