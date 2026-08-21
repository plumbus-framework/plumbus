// Forbidden-path scan for application sources (Gate 2 consumption surface).
// Reuses the same walker and GovernanceSignal shape as capability-source-scan.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GovernanceSeverity } from '../types/enums.js';
import type { GovernanceSignal } from '../types/governance.js';
import { listApplicationSourceFiles } from './source-walk.js';

interface ForbiddenPattern {
  rule: string;
  pattern: RegExp;
  description: string;
  remediation: string;
}

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    rule: 'architecture.forbidden-raw-sql-import',
    pattern: /from\s+['"](?:pg|postgres|drizzle-orm)(?:\/[^'"]*)?['"]/,
    description: 'imports a database driver or query builder directly',
    remediation: 'Use ctx.data repositories instead of importing pg, postgres, or drizzle-orm',
  },
  {
    rule: 'architecture.forbidden-create-execution-context',
    pattern: /\bcreateExecutionContext\s*\(/,
    description: 'calls createExecutionContext',
    remediation:
      'Receive ctx from the runtime; do not mint an execution context in application code',
  },
  {
    rule: 'architecture.forbidden-parallel-queue',
    pattern: /from\s+['"](?:bullmq|bull|bee-queue)['"]/,
    description: 'imports a parallel queue runner',
    remediation: 'Use Plumbus flows, jobs, and event consumers instead of a parallel queue',
  },
  {
    rule: 'architecture.forbidden-raw-provider-credential',
    pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AI_OPENAI_API_KEY|AI_ANTHROPIC_API_KEY)\b/,
    description: 'reads a raw provider API key',
    remediation:
      'Let the host adapter own credentials; application code must not read provider keys',
  },
];

/**
 * Scan `app/` for paths that bypass the declared runtime.
 * High severity so `plumbus verify` fails the process when any match.
 */
export function scanForbiddenPaths(appRoot: string = process.cwd()): GovernanceSignal[] {
  const appDir = path.join(appRoot, 'app');
  if (!fs.existsSync(appDir)) {
    return [];
  }

  const signals: GovernanceSignal[] = [];
  for (const filePath of listApplicationSourceFiles(appDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const rel = path.relative(appRoot, filePath);
    for (const item of FORBIDDEN_PATTERNS) {
      if (!item.pattern.test(content)) continue;
      signals.push({
        severity: GovernanceSeverity.High,
        rule: item.rule,
        description: `Application module "${rel}" ${item.description}`,
        affectedComponent: `file:${rel}`,
        remediation: item.remediation,
      });
    }
  }
  return signals;
}
