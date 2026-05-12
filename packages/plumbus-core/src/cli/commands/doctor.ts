// ── plumbus doctor ──
// Check environment readiness

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectMonorepoLayout,
  info,
  error as logError,
  resolvePath,
  success,
  warn,
} from '../utils.js';
import {
  AGENT_WIRING_VERSION,
  hasPatchableAgentWiringBlock,
  parseAgentWiringVersion,
} from './init.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export interface DoctorOptions {
  json?: boolean;
}

const GENERATED_AGENTS_TITLE = '# AGENTS.md — Plumbus Framework';

function isGeneratedAgentsMd(content: string): boolean {
  return content.includes(GENERATED_AGENTS_TITLE) || parseAgentWiringVersion(content) !== undefined;
}

/** Check whether generated agent wiring files are missing or stale */
export function checkAgentWiring(): DoctorCheck {
  const files = [
    { path: '.github/copilot-instructions.md', label: 'copilot', alwaysCandidate: true },
    { path: '.cursor/rules/plumbus.mdc', label: 'cursor', alwaysCandidate: true },
    {
      path: '.cursor/rules/plumbus-capabilities.mdc',
      label: 'cursor-capabilities',
      alwaysCandidate: true,
    },
    { path: 'AGENTS.md', label: 'agents-md', alwaysCandidate: false },
  ] as const;

  const detected: Array<{ path: string; version?: number; label: string; patchable: boolean }> = [];

  for (const file of files) {
    const absolutePath = resolvePath(file.path);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (!file.alwaysCandidate && !isGeneratedAgentsMd(content)) {
      continue;
    }

    detected.push({
      path: file.path,
      label: file.label,
      version: parseAgentWiringVersion(content),
      patchable: hasPatchableAgentWiringBlock(content),
    });
  }

  if (detected.length === 0) {
    return {
      name: 'agent-wiring',
      status: 'ok',
      message:
        'No generated agent wiring detected — run `plumbus init` if you use AI coding agents',
    };
  }

  const cursorMain = detected.some((file) => file.label === 'cursor');
  const cursorCapabilities = detected.some((file) => file.label === 'cursor-capabilities');
  const issues: string[] = [];
  let recommendedCommand = 'plumbus init --patch';

  if (cursorMain !== cursorCapabilities) {
    issues.push(
      'Cursor wiring is incomplete (.cursor/rules/plumbus.mdc and plumbus-capabilities.mdc should be generated together)',
    );
  }

  for (const file of detected) {
    if (file.version === undefined) {
      issues.push(
        `${file.path} is unversioned and may predate the current Plumbus wiring template`,
      );
      recommendedCommand = 'plumbus init --force';
      continue;
    }
    if (file.version < AGENT_WIRING_VERSION) {
      if (file.patchable) {
        issues.push(
          `${file.path} uses wiring version ${file.version} (current: ${AGENT_WIRING_VERSION})`,
        );
      } else {
        issues.push(
          `${file.path} uses wiring version ${file.version} but does not contain a patchable Plumbus-managed block`,
        );
        recommendedCommand = 'plumbus init --force';
      }
    }
  }

  if (issues.length > 0) {
    return {
      name: 'agent-wiring',
      status: 'warn',
      message: `${issues.join('; ')}. Review local customizations, then run \`${recommendedCommand}\` to refresh the generated wiring.`,
    };
  }

  return {
    name: 'agent-wiring',
    status: 'ok',
    message: `Generated agent wiring is current (template version ${AGENT_WIRING_VERSION})`,
  };
}

/** Check Node.js version */
export function checkNodeVersion(): DoctorCheck {
  const version = process.versions.node ?? '';
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    return { name: 'node', status: 'ok', message: `Node.js v${version}` };
  }
  if (major >= 18) {
    return { name: 'node', status: 'warn', message: `Node.js v${version} (v20+ recommended)` };
  }
  return { name: 'node', status: 'fail', message: `Node.js v${version} (v20+ required)` };
}

/** Check TypeScript availability */
export function checkTypeScript(): DoctorCheck {
  try {
    const pkgPath = resolvePath('node_modules', 'typescript', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      return { name: 'typescript', status: 'ok', message: `TypeScript v${pkg.version}` };
    }
    return { name: 'typescript', status: 'fail', message: 'TypeScript not installed' };
  } catch {
    return { name: 'typescript', status: 'fail', message: 'TypeScript not installed' };
  }
}

/** Check @plumbus/core availability */
export function checkPlumbusCore(): DoctorCheck {
  try {
    const pkgPath = resolvePath('node_modules', '@plumbus/core', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      return { name: '@plumbus/core', status: 'ok', message: `@plumbus/core v${pkg.version}` };
    }
    return {
      name: '@plumbus/core',
      status: 'warn',
      message: '@plumbus/core not found in node_modules (may be workspace root)',
    };
  } catch {
    return { name: '@plumbus/core', status: 'warn', message: '@plumbus/core not accessible' };
  }
}

/** Check config file exists */
export function checkConfig(): DoctorCheck {
  const configPath = resolvePath('config', 'app.config.ts');
  if (fs.existsSync(configPath)) {
    return { name: 'config', status: 'ok', message: 'config/app.config.ts found' };
  }
  return { name: 'config', status: 'warn', message: 'config/app.config.ts not found' };
}

/** Check app directory structure */
export function checkAppStructure(): DoctorCheck {
  const dirs = ['app/capabilities', 'app/entities', 'app/flows', 'app/events', 'app/prompts'];
  const existing = dirs.filter((d) => fs.existsSync(resolvePath(d)));
  if (existing.length === dirs.length) {
    return { name: 'app-structure', status: 'ok', message: 'All app/ directories present' };
  }
  if (existing.length > 0) {
    return {
      name: 'app-structure',
      status: 'warn',
      message: `Missing: ${dirs.filter((d) => !existing.includes(d)).join(', ')}`,
    };
  }
  return {
    name: 'app-structure',
    status: 'fail',
    message: 'app/ directory not found — run `plumbus create`',
  };
}

/** Check package.json exists */
export function checkPackageJson(): DoctorCheck {
  const pkgPath = resolvePath('package.json');
  if (fs.existsSync(pkgPath)) {
    return { name: 'package.json', status: 'ok', message: 'package.json found' };
  }
  return { name: 'package.json', status: 'fail', message: 'package.json not found' };
}

/** Check @plumbus/ui availability and version */
export function checkPlumbusUi(): DoctorCheck {
  try {
    const pkgPath = resolvePath('node_modules', '@plumbus/ui', 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {
        name: '@plumbus/ui',
        status: 'warn',
        message: '@plumbus/ui not found (skip if backend-only)',
      };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    const version = pkg.version ?? 'unknown';

    // Check that the bundled next/react versions are current
    const nextRange = pkg.dependencies?.next ?? '';
    const reactRange = pkg.dependencies?.react ?? '';
    const warnings: string[] = [];

    if (nextRange && !nextRange.includes('16')) {
      warnings.push(`next ${nextRange} (v16+ expected)`);
    }
    if (reactRange && !reactRange.includes('19')) {
      warnings.push(`react ${reactRange} (v19+ expected)`);
    }

    if (warnings.length > 0) {
      return {
        name: '@plumbus/ui',
        status: 'warn',
        message: `@plumbus/ui v${version} — outdated deps: ${warnings.join(', ')}. Run \`plumbus upgrade\` or update @plumbus/ui`,
      };
    }

    return { name: '@plumbus/ui', status: 'ok', message: `@plumbus/ui v${version}` };
  } catch {
    return { name: '@plumbus/ui', status: 'warn', message: '@plumbus/ui not accessible' };
  }
}

/** Resolve the frontend directory for legacy artifact detection */
function resolveFrontendDir(): string | undefined {
  const layout = detectMonorepoLayout();
  if (layout.isMonorepo && layout.frontendDir && fs.existsSync(layout.frontendDir)) {
    return layout.frontendDir;
  }
  // Single-project: check for Next.js markers in CWD
  const cwd = process.cwd();
  if (
    fs.existsSync(path.join(cwd, 'next.config.ts')) ||
    fs.existsSync(path.join(cwd, 'next.config.js')) ||
    fs.existsSync(path.join(cwd, 'next.config.mjs'))
  ) {
    return cwd;
  }
  return undefined;
}

/** Check for stale legacy UI artifacts (generated/, middleware.ts, API proxy route) */
export function checkLegacyArtifacts(): DoctorCheck {
  const frontendDir = resolveFrontendDir();
  if (!frontendDir) {
    return {
      name: 'legacy-artifacts',
      status: 'ok',
      message: 'No frontend directory detected — skipped',
    };
  }

  const stale: string[] = [];
  if (fs.existsSync(path.join(frontendDir, 'generated'))) {
    stale.push('generated/');
  }
  if (fs.existsSync(path.join(frontendDir, 'middleware.ts'))) {
    stale.push('middleware.ts');
  }
  if (fs.existsSync(path.join(frontendDir, 'app', 'api', 'plumbus', '[...path]', 'route.ts'))) {
    stale.push('app/api/plumbus/[...path]/route.ts');
  }

  if (stale.length > 0) {
    return {
      name: 'legacy-artifacts',
      status: 'warn',
      message: `Stale artifacts found: ${stale.join(', ')}. Run \`plumbus upgrade\` to migrate`,
    };
  }

  return { name: 'legacy-artifacts', status: 'ok', message: 'No legacy artifacts detected' };
}

/** Check PostgreSQL connectivity */
export async function checkPostgreSQL(): Promise<DoctorCheck> {
  try {
    const configPath = resolvePath('config', 'app.config.ts');
    if (!fs.existsSync(configPath)) {
      return {
        name: 'postgresql',
        status: 'warn',
        message: 'Config not found — cannot test PostgreSQL',
      };
    }
    // Attempt a TCP connection to the configured host:port
    const { loadConfig } = await import('../../config/loader.js');
    const config = loadConfig();
    const net = await import('node:net');
    return await new Promise<DoctorCheck>((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({
          name: 'postgresql',
          status: 'fail',
          message: `PostgreSQL not reachable at ${config.database.host}:${config.database.port}`,
        });
      }, 3000);
      socket.connect(config.database.port, config.database.host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          name: 'postgresql',
          status: 'ok',
          message: `PostgreSQL reachable at ${config.database.host}:${config.database.port}`,
        });
      });
      socket.on('error', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          name: 'postgresql',
          status: 'fail',
          message: `PostgreSQL not reachable at ${config.database.host}:${config.database.port}`,
        });
      });
    });
  } catch {
    return {
      name: 'postgresql',
      status: 'warn',
      message: 'Could not check PostgreSQL connectivity',
    };
  }
}

/** Check Redis connectivity */
export async function checkRedis(): Promise<DoctorCheck> {
  try {
    const configPath = resolvePath('config', 'app.config.ts');
    if (!fs.existsSync(configPath)) {
      return { name: 'redis', status: 'warn', message: 'Config not found — cannot test Redis' };
    }
    const { loadConfig } = await import('../../config/loader.js');
    const config = loadConfig();
    const net = await import('node:net');
    return await new Promise<DoctorCheck>((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({
          name: 'redis',
          status: 'fail',
          message: `Redis not reachable at ${config.queue.host}:${config.queue.port}`,
        });
      }, 3000);
      socket.connect(config.queue.port, config.queue.host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          name: 'redis',
          status: 'ok',
          message: `Redis reachable at ${config.queue.host}:${config.queue.port}`,
        });
      });
      socket.on('error', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          name: 'redis',
          status: 'fail',
          message: `Redis not reachable at ${config.queue.host}:${config.queue.port}`,
        });
      });
    });
  } catch {
    return { name: 'redis', status: 'warn', message: 'Could not check Redis connectivity' };
  }
}

/** Run all doctor checks (sync checks only) */
export function runDoctorChecks(): DoctorCheck[] {
  return [
    checkNodeVersion(),
    checkTypeScript(),
    checkPlumbusCore(),
    checkPlumbusUi(),
    checkPackageJson(),
    checkConfig(),
    checkAppStructure(),
    checkAgentWiring(),
    checkLegacyArtifacts(),
  ];
}

/** Run all doctor checks including async connectivity tests */
export async function runFullDoctorChecks(): Promise<DoctorCheck[]> {
  const syncChecks = runDoctorChecks();
  const [pgCheck, redisCheck] = await Promise.all([checkPostgreSQL(), checkRedis()]);
  return [...syncChecks, pgCheck, redisCheck];
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check environment readiness')
    .option('--json', 'Output as JSON')
    .action(async (opts: DoctorOptions) => {
      const checks = await runFullDoctorChecks();

      if (opts.json) {
        console.log(JSON.stringify({ checks }, null, 2));
        return;
      }

      console.log('\nPlumbus Doctor\n');
      for (const check of checks) {
        switch (check.status) {
          case 'ok':
            success(`${check.name}: ${check.message}`);
            break;
          case 'warn':
            warn(`${check.name}: ${check.message}`);
            break;
          case 'fail':
            logError(`${check.name}: ${check.message}`);
            break;
        }
      }

      const fails = checks.filter((c) => c.status === 'fail');
      const warns = checks.filter((c) => c.status === 'warn');
      console.log(
        `\n${checks.length - fails.length - warns.length} passed, ${warns.length} warnings, ${fails.length} failures`,
      );

      if (fails.length > 0) {
        info('Fix the failures above before starting development.');
        process.exit(1);
      }
    });
}
