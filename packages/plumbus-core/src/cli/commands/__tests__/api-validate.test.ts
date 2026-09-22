import { describe, expect, it } from 'vitest';
import { apiValidateShouldFail } from '../api.js';

describe('apiValidateShouldFail', () => {
  const gov = [{ rule: 'api.missing-auth', description: 'advisory signal' }];

  it('fails on hard contract findings', () => {
    expect(apiValidateShouldFail([{ code: 'x', message: 'y' }], [], {})).toBe(true);
  });

  it('does not fail on governance signals alone (advisory)', () => {
    expect(apiValidateShouldFail([], gov, {})).toBe(false);
  });

  it('fails on governance signals when --fail-on-governance', () => {
    expect(apiValidateShouldFail([], gov, { failOnGovernance: true })).toBe(true);
  });

  it('passes when both lists empty', () => {
    expect(apiValidateShouldFail([], [], {})).toBe(false);
  });
});
