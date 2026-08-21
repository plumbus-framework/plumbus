/**
 * F-09 / DEC-14 action-risk vocabulary.
 *
 * Single import for Plan 02 Stage 4. Values are the frozen three-tier set
 * (read-only, limited-reversible, consequential). Callers keep these names
 * if the host later swaps the catalog module.
 */

export const ActionRiskTier = {
  ReadOnly: 'read-only',
  LimitedReversible: 'limited-reversible',
  Consequential: 'consequential',
} as const;

export type ActionRiskTier = (typeof ActionRiskTier)[keyof typeof ActionRiskTier];

export const ACTION_RISK_TIERS = [
  ActionRiskTier.ReadOnly,
  ActionRiskTier.LimitedReversible,
  ActionRiskTier.Consequential,
] as const;

export const ReviewMandateReason = {
  RiskTier: 'risk-tier',
  ApplicationMandated: 'application-mandated',
} as const;

export type ReviewMandateReason = (typeof ReviewMandateReason)[keyof typeof ReviewMandateReason];

/** Retired DEC-14 values. defineCapability rejects these; do not accept at runtime. */
export const RETIRED_ACTION_RISK_VALUES = [
  'read',
  'routine-write',
  'sensitive-write',
  'analytical',
  'reversible-change',
] as const;

export type RetiredActionRiskValue = (typeof RETIRED_ACTION_RISK_VALUES)[number];

const TIER_SET = new Set<string>(ACTION_RISK_TIERS);

export function isActionRiskTier(value: unknown): value is ActionRiskTier {
  return typeof value === 'string' && TIER_SET.has(value);
}

/** Only `consequential` requires the mandatory approval gate. */
export function requiresApprovalForRiskTier(tier: ActionRiskTier | undefined): boolean {
  return tier === ActionRiskTier.Consequential;
}

export function capabilityDefinitionVersion(capability: { version?: string }): string {
  return capability.version ?? '1';
}
