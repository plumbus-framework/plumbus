import { describe, expect, it } from 'vitest';
import {
  ActionRiskTier,
  isActionRiskTier,
  requiresApprovalForRiskTier,
  RETIRED_ACTION_RISK_VALUES,
} from '../action-risk.js';

describe('Action-risk vocabulary', () => {
  it('accepts the frozen catalog tiers only', () => {
    expect(isActionRiskTier('read-only')).toBe(true);
    expect(isActionRiskTier('limited-reversible')).toBe(true);
    expect(isActionRiskTier('consequential')).toBe(true);
    for (const retired of RETIRED_ACTION_RISK_VALUES) {
      expect(isActionRiskTier(retired)).toBe(false);
    }
  });

  it('requires the approval gate only for consequential', () => {
    expect(requiresApprovalForRiskTier(ActionRiskTier.ReadOnly)).toBe(false);
    expect(requiresApprovalForRiskTier(ActionRiskTier.LimitedReversible)).toBe(false);
    expect(requiresApprovalForRiskTier(ActionRiskTier.Consequential)).toBe(true);
    expect(requiresApprovalForRiskTier(undefined)).toBe(false);
  });
});
