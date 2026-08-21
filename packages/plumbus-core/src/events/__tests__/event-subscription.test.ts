import { describe, expect, it } from 'vitest';
import { evaluateEventSubscriptionDelivery } from '../subscription.js';

describe('evaluateEventSubscriptionDelivery', () => {
  it('delivers when active and policy allows', () => {
    expect(evaluateEventSubscriptionDelivery({ active: true, policyAllowed: true })).toEqual({
      deliver: true,
    });
  });

  it('skips inactive subscriptions without dead-letter', () => {
    expect(evaluateEventSubscriptionDelivery({ active: false, policyAllowed: true })).toEqual({
      deliver: false,
      reason: 'inactive',
    });
  });

  it('skips when delivery policy denies', () => {
    expect(evaluateEventSubscriptionDelivery({ active: true, policyAllowed: false })).toEqual({
      deliver: false,
      reason: 'policy-denied',
    });
  });

  it('defaults active and policy to allow', () => {
    expect(evaluateEventSubscriptionDelivery({})).toEqual({ deliver: true });
  });
});
