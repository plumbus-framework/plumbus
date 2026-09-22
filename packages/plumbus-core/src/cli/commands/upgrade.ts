// ── plumbus upgrade ──
// Migrate legacy artifacts and report version status after framework upgrades

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectMonorepoLayout,
  info,
  migrateUiLegacyStructure,
  resolvePath,
  success,
  warn,
} from '../utils.js';

export interface UpgradeOptions {
  dryRun?: boolean;
}

/** Resolve the frontend directory for migration */
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

/** Check for stale legacy artifacts without modifying them */
function detectLegacyArtifacts(frontendDir: string): string[] {
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
  return stale;
}

/** Report version information for @plumbus/ui and its bundled deps */
function reportVersions(): void {
  const uiPkgPath = resolvePath('node_modules', '@plumbus/ui', 'package.json');
  if (!fs.existsSync(uiPkgPath)) {
    info('@plumbus/ui not installed — skipping version report');
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(uiPkgPath, 'utf-8')) as {
    version?: string;
    dependencies?: Record<string, string>;
  };

  console.log('\nFramework versions:');
  success(`@plumbus/ui ${pkg.version ?? 'unknown'}`);

  if (pkg.dependencies) {
    const deps = ['next', 'react', 'react-dom', 'tailwindcss'] as const;
    for (const dep of deps) {
      const range = pkg.dependencies[dep];
      if (range) {
        info(`  ${dep}: ${range}`);
      }
    }
  }
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Migrate legacy artifacts and report version status after framework upgrades')
    .option('--dry-run', 'Show what would be migrated without making changes')
    .action((opts: UpgradeOptions) => {
      console.log('\nPlumbus Upgrade\n');

      const frontendDir = resolveFrontendDir();

      if (!frontendDir) {
        info('No frontend directory detected — nothing to migrate');
        reportVersions();
        return;
      }

      const stale = detectLegacyArtifacts(frontendDir);

      if (stale.length === 0) {
        success('No legacy artifacts found — project is up to date');
        reportVersions();
        return;
      }

      if (opts.dryRun) {
        console.log('Legacy artifacts detected (dry run — no changes made):');
        for (const artifact of stale) {
          warn(`  ${artifact}`);
        }
        reportVersions();
        return;
      }

      info(`Migrating legacy artifacts in ${path.relative(process.cwd(), frontendDir) || '.'} …`);
      const result = migrateUiLegacyStructure(frontendDir);

      const totalChanges =
        result.movedFiles.length + result.rewrittenImports.length + result.deletedPaths.length;

      if (totalChanges === 0) {
        success('No migrations needed');
      } else {
        if (result.movedFiles.length > 0) {
          console.log('\nMoved files:');
          for (const f of result.movedFiles) {
            success(`  ${f}`);
          }
        }
        if (result.rewrittenImports.length > 0) {
          console.log('\nRewritten imports:');
          for (const f of result.rewrittenImports) {
            success(`  ${f}`);
          }
        }
        if (result.deletedPaths.length > 0) {
          console.log('\nDeleted:');
          for (const f of result.deletedPaths) {
            success(`  ${f}`);
          }
        }
        console.log(
          `\n${totalChanges} change${totalChanges === 1 ? '' : 's'} applied successfully`,
        );
      }

      reportVersions();
    });
}
