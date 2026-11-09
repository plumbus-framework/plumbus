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

describe('apiValidateShouldFail security findings', () => {
  const securityError = { code: 'manifest.security.unsupported-query-api-key', message: 'm' };
  const securityWarning = {
    code: 'manifest.security.legacy-default-auth',
    message: 'm',
    severity: 'warning' as const,
  };

  it('does not fail on security findings without --fail-on-security (0.8 default)', () => {
    expect(apiValidateShouldFail([], [], {}, [securityError])).toBe(false);
  });

  it('fails on error-severity security findings with --fail-on-security', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: true }, [securityError])).toBe(true);
    expect(
      apiValidateShouldFail([], [], { failOnSecurity: true }, [
        { ...securityError, severity: 'error' },
      ]),
    ).toBe(true);
  });

  it('never fails on warning-only security findings', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: true }, [securityWarning])).toBe(false);
  });

  it('passes with --fail-on-security when there are no security findings', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: true })).toBe(false);
  });
});
