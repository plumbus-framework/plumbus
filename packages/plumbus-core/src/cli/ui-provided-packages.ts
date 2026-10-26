// ── Packages @plumbus/ui supplies to the app ──
//
// `@plumbus/ui` brings Next.js, React, Tailwind and TypeScript as its own dependencies, so a
// Plumbus upgrade is what moves them (security fixes included). An app that declares one of them
// again pins its own copy: it keeps the old version after the framework moves on, and can load
// two copies of Next or React in one build. Under pnpm the app reaches them only when they are
// hoisted (`publicHoistPattern`). `checkUiProvidedPackages` reads all three facts from disk.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The packages `@plumbus/ui` supplies when its manifest does not list them itself (`plumbus.provides`
 * in its `package.json`, from 0.10.0-beta.1). Mirrors AGENTS.md, "From `@plumbus/ui`".
 */
export const UI_PROVIDED_PACKAGES = [
  'next',
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  'tailwindcss',
  '@tailwindcss/postcss',
  'typescript',
] as const;

export interface UiProvidedPackagesReport {
  /** `skip`: no `@plumbus/ui` installed (backend-only app). */
  status: 'ok' | 'fail' | 'skip';
  provided: string[];
  issues: string[];
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  plumbus?: { provides?: unknown };
}

function readJson(file: string): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Manifest;
  } catch {
    return undefined;
  }
}

/** The string items of one top-level YAML sequence (`key:` followed by `  - item` lines). */
function yamlSequence(text: string, key: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (match?.[1]) items.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return items;
}

/** Workspace member directories named by `pnpm-workspace.yaml` (`dir` and `dir/*` forms). */
function workspaceMembers(root: string, workspaceYaml: string): string[] {
  const dirs: string[] = [];
  for (const pattern of yamlSequence(workspaceYaml, 'packages')) {
    if (pattern.startsWith('!')) continue;
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
      }
    } else if (!pattern.includes('*')) {
      dirs.push(path.join(root, pattern));
    }
  }
  return dirs;
}

/** pnpm's `publicHoistPattern` from `pnpm-workspace.yaml` and `.npmrc`. */
function publicHoistPatterns(root: string, workspaceYaml: string): string[] {
  const patterns = yamlSequence(workspaceYaml, 'publicHoistPattern');
  const npmrc = path.join(root, '.npmrc');
  if (fs.existsSync(npmrc)) {
    for (const line of fs.readFileSync(npmrc, 'utf-8').split('\n')) {
      const match = /^\s*public-hoist-pattern(?:\[\])?\s*=\s*(.+?)\s*$/.exec(line);
      if (match?.[1]) patterns.push(match[1]);
    }
  }
  return patterns;
}

function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** Versions per package name in the `packages:` section of a pnpm lockfile. */
export function lockfileVersions(lockfile: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let inPackages = false;
  for (const line of lockfile.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line.trimEnd() === 'packages:';
      continue;
    }
    if (!inPackages) continue;
    const match = /^ {2}'?((?:@[^@/\s']+\/)?[^@\s']+)@([^('\s:]+)/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const set = versions.get(match[1]) ?? new Set<string>();
    set.add(match[2]);
    versions.set(match[1], set);
  }
  return versions;
}

/**
 * Check that the app takes the packages `@plumbus/ui` supplies from it: no manifest in the
 * workspace declares them, pnpm hoists them, and the lockfile holds one version of each.
 */
export function checkUiProvidedPackages(root: string = process.cwd()): UiProvidedPackagesReport {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  const workspaceYaml = fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, 'utf-8') : '';
  const members = workspaceMembers(root, workspaceYaml);
  const manifestDirs = [root, ...members];

  const uiManifestPath = manifestDirs
    .map((dir) => path.join(dir, 'node_modules', '@plumbus', 'ui', 'package.json'))
    .find((file) => fs.existsSync(file));
  if (!uiManifestPath) return { status: 'skip', provided: [], issues: [] };

  const uiManifest = readJson(uiManifestPath);
  const declared = uiManifest?.plumbus?.provides;
  const provided =
    Array.isArray(declared) && declared.every((name) => typeof name === 'string')
      ? (declared as string[])
      : [...UI_PROVIDED_PACKAGES];

  const issues: string[] = [];
  for (const dir of manifestDirs) {
    const manifest = readJson(path.join(dir, 'package.json'));
    if (!manifest) continue;
    const label = path.relative(root, path.join(dir, 'package.json')) || 'package.json';
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (provided.includes(name)) {
          issues.push(`${label} declares ${name} in ${field}; @plumbus/ui supplies it — remove it`);
        }
      }
    }
  }

  const lockFile = path.join(root, 'pnpm-lock.yaml');
  const usesPnpm = workspaceYaml !== '' || fs.existsSync(lockFile);
  if (usesPnpm) {
    const patterns = publicHoistPatterns(root, workspaceYaml);
    for (const name of provided) {
      if (!patterns.some((pattern) => matchesPattern(name, pattern))) {
        issues.push(
          `${name} is not in publicHoistPattern (pnpm-workspace.yaml), so the app cannot import it`,
        );
      }
    }
  }
  if (fs.existsSync(lockFile)) {
    const versions = lockfileVersions(fs.readFileSync(lockFile, 'utf-8'));
    for (const name of provided) {
      const found = versions.get(name);
      if (found && found.size > 1) {
        issues.push(
          `pnpm-lock.yaml holds ${found.size} versions of ${name} (${[...found].sort().join(', ')}); one copy must serve the app`,
        );
      }
    }
  }

  return { status: issues.length > 0 ? 'fail' : 'ok', provided, issues };
}
