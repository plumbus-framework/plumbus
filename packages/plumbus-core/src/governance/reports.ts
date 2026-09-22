// ── Policy Compatibility Report Generator ──
// Evaluates all rules in a policy profile, produces structured report with
// compatibility score, per-rule results, override list, and remediation recommendations.

import type { GovernanceOverride, PolicyReport, RuleEvaluation } from '../types/governance.js';
import { builtInProfiles, evaluatePolicyProfile } from './policies.js';
import type { SystemInventory } from './rule-engine.js';

// ── Report Options ──
export interface ReportOptions {
  /** Include remediation recommendations in the report */
  includeRemediation?: boolean;
  /** Include overridden rules in recommendations */
  includeOverriddenRecommendations?: boolean;
}

/** Generate a full policy compatibility report */
export function generatePolicyReport(
  profileName: string,
  inventory: SystemInventory,
  overrides: GovernanceOverride[] = [],
  options: ReportOptions = {},
): PolicyReport {
  const { results, score } = evaluatePolicyProfile(profileName, inventory, overrides);

  const recommendations: string[] = [];
  if (options.includeRemediation !== false) {
    for (const result of results) {
      if (result.status === 'fail' || result.status === 'partial') {
        if (result.remediation) {
          recommendations.push(`[${result.rule}] ${result.remediation}`);
        }
      }
      if (
        options.includeOverriddenRecommendations &&
        result.status === 'override' &&
        result.remediation
      ) {
        recommendations.push(`[${result.rule}] (overridden) ${result.remediation}`);
      }
    }
  }

  const appliedOverrides = overrides.filter((o) =>
    results.some((r) => r.rule === o.rule && r.status === 'override'),
  );

  return {
    policy: profileName,
    timestamp: new Date(),
    compatibilityScore: score,
    results,
    overrides: appliedOverrides,
    recommendations,
  };
}

/** Generate reports for all built-in policy profiles */
export function generateAllPolicyReports(
  inventory: SystemInventory,
  overrides: GovernanceOverride[] = [],
  options: ReportOptions = {},
): PolicyReport[] {
  return Object.keys(builtInProfiles).map((profileName) =>
    generatePolicyReport(profileName, inventory, overrides, options),
  );
}

/** Format a policy report as human-readable text */
export function formatPolicyReport(report: PolicyReport): string {
  const lines: string[] = [];
  lines.push(`Policy: ${report.policy}`);
  lines.push(`Compatibility Score: ${report.compatibilityScore}%`);
  lines.push(`Evaluated: ${report.timestamp.toISOString()}`);
  lines.push('');
  lines.push('Results:');

  for (const result of report.results) {
    const icon = formatStatusIcon(result.status);
    lines.push(`  ${icon} ${result.rule}: ${result.description ?? ''} [${result.status}]`);
  }

  if (report.overrides && report.overrides.length > 0) {
    lines.push('');
    lines.push('Overrides:');
    for (const override of report.overrides) {
      lines.push(`  - ${override.rule}: ${override.justification} (by ${override.author})`);
    }
  }

  if (report.recommendations && report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommendations:');
    for (const rec of report.recommendations) {
      lines.push(`  - ${rec}`);
    }
  }

  return lines.join('\n');
}

function formatStatusIcon(status: RuleEvaluation['status']): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'partial':
      return '~';
    case 'fail':
      return '✗';
    case 'override':
      return '⊘';
    default:
      return '?';
  }
}
