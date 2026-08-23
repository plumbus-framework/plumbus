// ── Capability source scan for direct handler imports ──

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GovernanceSeverity } from '../types/enums.js';
import type { GovernanceSignal } from '../types/governance.js';
import { listApplicationSourceFiles } from './source-walk.js';

const CAPABILITY_IMPORT = /import\s+.*\s+from\s+['"](?:\.\.?\/)*.*capabilities\/[^'"]+['"]/;
const HANDLER_ACCESS = /\b\w+\.handler\b/;
const EXECUTE_CAPABILITY = /\bexecuteCapability\s*\(/;

/**
 * Scan capability source files under app/capabilities for patterns that bypass
 * ctx.capabilities.invoke. Advisory only in v1.
 */
export function scanCapabilityDirectImports(appRoot: string = process.cwd()): GovernanceSignal[] {
  const capDir = path.join(appRoot, 'app', 'capabilities');
  if (!fs.existsSync(capDir)) {
    return [];
  }

  const signals: GovernanceSignal[] = [];
  const files = listApplicationSourceFiles(capDir);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const rel = path.relative(appRoot, filePath);

    if (CAPABILITY_IMPORT.test(content)) {
      signals.push({
        severity: GovernanceSeverity.Warning,
        rule: 'architecture.direct-capability-handler-import',
        description: `Capability module "${rel}" imports another capability module directly`,
        affectedComponent: `file:${rel}`,
        remediation:
          'Use ctx.capabilities.invoke(...) and declare the target in effects.capabilities instead of importing capability modules',
      });
    }

    if (HANDLER_ACCESS.test(content)) {
      signals.push({
        severity: GovernanceSeverity.Warning,
        rule: 'architecture.direct-capability-handler-import',
        description: `Capability module "${rel}" accesses another capability's .handler directly`,
        affectedComponent: `file:${rel}`,
        remediation:
          'Use ctx.capabilities.invoke(...) and declare the target in effects.capabilities',
      });
    }

    if (EXECUTE_CAPABILITY.test(content)) {
      signals.push({
        severity: GovernanceSeverity.Warning,
        rule: 'architecture.direct-capability-handler-import',
        description: `Capability module "${rel}" calls executeCapability() from application code`,
        affectedComponent: `file:${rel}`,
        remediation:
          'Use ctx.capabilities.invoke(...) from inside capability handlers instead of calling executeCapability directly',
      });
    }
  }

  return signals;
}
