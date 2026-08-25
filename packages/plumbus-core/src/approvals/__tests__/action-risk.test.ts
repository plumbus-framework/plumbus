import { describe, expect, it } from 'vitest';
import {
  ActionRiskTier,
  isActionRiskTier,
  isProhibitedRiskTier,
  requiresApprovalForRiskTier,
  RETIRED_ACTION_RISK_VALUES,
} from '../action-risk.js';

describe('Action-risk vocabulary', () => {
  it('accepts the frozen catalog tiers only', () => {
    expect(isActionRiskTier('analytical')).toBe(true);
    expect(isActionRiskTier('limited-reversible')).toBe(true);
    expect(isActionRiskTier('consequential')).toBe(true);
    expect(isActionRiskTier('prohibited')).toBe(true);
    for (const retired of RETIRED_ACTION_RISK_VALUES) {
      expect(isActionRiskTier(retired)).toBe(false);
    }
  });

  it('retires read-only, the former name of the analytical tier', () => {
    expect(RETIRED_ACTION_RISK_VALUES).toContain('read-only');
    expect(RETIRED_ACTION_RISK_VALUES).not.toContain('analytical');
    expect(isActionRiskTier('read-only')).toBe(false);
  });

  it('requires the approval gate only for consequential', () => {
    expect(requiresApprovalForRiskTier(ActionRiskTier.Analytical)).toBe(false);
    expect(requiresApprovalForRiskTier(ActionRiskTier.LimitedReversible)).toBe(false);
    expect(requiresApprovalForRiskTier(ActionRiskTier.Consequential)).toBe(true);
    expect(requiresApprovalForRiskTier(ActionRiskTier.Prohibited)).toBe(false);
    expect(requiresApprovalForRiskTier(undefined)).toBe(false);
  });

  it('flags only prohibited as prohibited', () => {
    expect(isProhibitedRiskTier(ActionRiskTier.Prohibited)).toBe(true);
    expect(isProhibitedRiskTier(ActionRiskTier.Analytical)).toBe(false);
    expect(isProhibitedRiskTier(ActionRiskTier.LimitedReversible)).toBe(false);
    expect(isProhibitedRiskTier(ActionRiskTier.Consequential)).toBe(false);
    expect(isProhibitedRiskTier(undefined)).toBe(false);
  });
});
