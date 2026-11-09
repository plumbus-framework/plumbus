import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  API_VALIDATE_SECURITY_ADVISORY_NOTICE,
  apiValidateShouldFail,
  buildApiValidateJsonReport,
  registerApiCommand,
} from '../api.js';

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

  it('fails on error-severity security findings by default (0.9)', () => {
    expect(apiValidateShouldFail([], [], {}, [securityError])).toBe(true);
    expect(apiValidateShouldFail([], [], {}, [{ ...securityError, severity: 'error' }])).toBe(true);
  });

  it('still fails with the legacy --fail-on-security flag', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: true }, [securityError])).toBe(true);
  });

  it('does not fail on security findings with --no-fail-on-security', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: false }, [securityError])).toBe(false);
  });

  it('never fails on warning-only security findings by default', () => {
    expect(apiValidateShouldFail([], [], {}, [securityWarning])).toBe(false);
  });

  it('never fails on warning-only security findings', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: true }, [securityWarning])).toBe(false);
  });

  it('passes with --fail-on-security when there are no security findings', () => {
    expect(apiValidateShouldFail([], [], { failOnSecurity: true })).toBe(false);
  });
});

describe('plumbus api validate security options', () => {
  const parseValidateOpts = (args: string[]): Record<string, unknown> => {
    const program = new Command();
    program.exitOverride();
    registerApiCommand(program);
    const api = program.commands.find((c) => c.name() === 'api');
    const validate = api?.commands.find((c) => c.name() === 'validate');
    if (!validate) throw new Error('validate command missing');
    validate.action(() => {});
    program.parse(['node', 'plumbus', 'api', 'validate', ...args]);
    return validate.opts();
  };

  it('leaves failOnSecurity unset by default so the policy treats it as on', () => {
    expect(parseValidateOpts([]).failOnSecurity).toBeUndefined();
  });

  it('accepts --fail-on-security as a no-op and --no-fail-on-security as the opt-out', () => {
    expect(parseValidateOpts(['--fail-on-security']).failOnSecurity).toBe(true);
    expect(parseValidateOpts(['--no-fail-on-security']).failOnSecurity).toBe(false);
  });

  it('notice names the opt-out flag', () => {
    expect(API_VALIDATE_SECURITY_ADVISORY_NOTICE).toContain('--no-fail-on-security');
    expect(API_VALIDATE_SECURITY_ADVISORY_NOTICE).not.toContain('0.8');
  });
});

describe('buildApiValidateJsonReport', () => {
  const securityError = { code: 'manifest.security.unsupported-query-api-key', message: 'm' };
  const base = { manifest: [], policy: [], pathParams: [], fixtures: [], ok: false };

  it('reports ok: false when the command fails', () => {
    const report = buildApiValidateJsonReport(base, [securityError], [], {
      failed: true,
      failOnSecurity: true,
    });
    expect(report.ok).toBe(false);
    expect(report.securityFailsCommand).toBe(true);
  });

  it('reports ok: true when security findings are opted out and nothing else fails', () => {
    const report = buildApiValidateJsonReport(base, [securityError], [], {
      failed: false,
      failOnSecurity: false,
    });
    expect(report.ok).toBe(true);
    expect(report.securityFailsCommand).toBe(false);
  });

  it('reports ok: false for --fail-on-governance failures the api package does not see', () => {
    const report = buildApiValidateJsonReport({ ...base, ok: true }, [], [], {
      failed: true,
      failOnSecurity: true,
    });
    expect(report.ok).toBe(false);
  });
});
