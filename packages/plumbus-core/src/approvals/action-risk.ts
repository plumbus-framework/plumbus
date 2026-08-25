/**
 * Action-risk vocabulary.
 *
 * Single import point for the approval gate. Values are the frozen four-tier
 * set (analytical, limited-reversible, consequential, prohibited). Callers keep
 * these names if the host later swaps the catalog module.
 *
 * `prohibited` is normative, not descriptive: a prohibited action cannot be
 * invoked, cannot be proposed for approval, and is not exposed as available.
 * The approval gate refuses it outright — creating an approval request never
 * makes a prohibited action permissible.
 */

export const ActionRiskTier = {
  Analytical: 'analytical',
  LimitedReversible: 'limited-reversible',
  Consequential: 'consequential',
  Prohibited: 'prohibited',
} as const;

export type ActionRiskTier = (typeof ActionRiskTier)[keyof typeof ActionRiskTier];

export const ACTION_RISK_TIERS = [
  ActionRiskTier.Analytical,
  ActionRiskTier.LimitedReversible,
  ActionRiskTier.Consequential,
  ActionRiskTier.Prohibited,
] as const;

export const ReviewMandateReason = {
  RiskTier: 'risk-tier',
  ApplicationMandated: 'application-mandated',
} as const;

export type ReviewMandateReason = (typeof ReviewMandateReason)[keyof typeof ReviewMandateReason];

/** Retired risk values. defineCapability rejects these; do not accept at runtime. */
export const RETIRED_ACTION_RISK_VALUES = [
  'read',
  'read-only',
  'routine-write',
  'sensitive-write',
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

/**
 * `prohibited` can never run: not invoked, not proposed for approval, not
 * exposed as available. Approval must not be able to make it permissible, so
 * it deliberately does not route through the approval gate.
 */
export function isProhibitedRiskTier(tier: ActionRiskTier | undefined): boolean {
  return tier === ActionRiskTier.Prohibited;
}

export function capabilityDefinitionVersion(capability: { version?: string }): string {
  return capability.version ?? '1';
}
