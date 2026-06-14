// ── CLI Utilities ──
// Shared helpers for CLI commands

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolve an absolute path from CWD */
export function resolvePath(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

/** Check if a file or directory exists */
export function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/** Read a JSON file and parse it */
export function readJson<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

/** Write content to a file, creating directories if needed */
export function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** Convert a string to kebab-case */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Skill file basename for a capability (short name or canonical `domain.name`). */
export function capabilitySkillBasename(ref: { name: string } | string): string {
  if (typeof ref === 'string') {
    const dot = ref.indexOf('.');
    const shortName = dot > 0 ? ref.slice(dot + 1) : ref;
    return toKebabCase(shortName);
  }
  return toKebabCase(ref.name);
}

/** Convert a string to PascalCase */
export function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/** Convert a string to camelCase */
export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Format output as JSON or human-readable */
export function formatOutput(data: unknown, options: { json?: boolean }): string {
  if (options.json) {
    return JSON.stringify(data, null, 2);
  }
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

/** Print success message */
export function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

/** Print warning message */
export function warn(msg: string): void {
  console.log(`⚠ ${msg}`);
}

/** Print error message */
export function error(msg: string): void {
  console.error(`✗ ${msg}`);
}

/** Print info message */
export function info(msg: string): void {
  console.log(`ℹ ${msg}`);
}

/**
 * Walk up the directory tree from `from` looking for a package.json that
 * lists `@plumbus/core` as a dependency or devDependency.
 * Returns the directory path if found, or `undefined`.
 */
export function findPlumbusProjectRoot(from: string = process.cwd()): string | undefined {
  let dir = path.resolve(from);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const deps = pkg.dependencies as Record<string, unknown> | undefined;
        const devDeps = pkg.devDependencies as Record<string, unknown> | undefined;
        if (deps?.['@plumbus/core'] || devDeps?.['@plumbus/core']) {
          return dir;
        }
      } catch {
        // Malformed package.json — skip
      }
    }
    dir = path.dirname(dir);
  }

  return undefined;
}

/** Commands that may run outside a Plumbus project. */
const PROJECT_EXEMPT_COMMANDS = new Set(['create', 'doctor', 'init']);

/**
 * Returns true if the given command name requires a Plumbus project context.
 */
export function commandRequiresProject(commandName: string): boolean {
  return !PROJECT_EXEMPT_COMMANDS.has(commandName);
}

/**
 * Assert the CWD is inside a Plumbus project.
 * Prints a clear error and calls `process.exit(1)` when not.
 */
export function assertInsidePlumbusProject(from?: string): void {
  if (!findPlumbusProjectRoot(from)) {
    error(
      'This command must be run inside a Plumbus project (a directory with @plumbus/core in package.json). ' +
        'Run "plumbus create <app-name>" to create a new project.',
    );
    process.exit(1);
  }
}

export interface MonorepoLayout {
  isMonorepo: boolean;
  backendDir?: string;
  frontendDir?: string;
  sharedTypesDir?: string;
}

/**
 * Detect whether the current project is a pnpm-workspace monorepo scaffolded
 * by `plumbus create --monorepo`. Returns directory paths for each package.
 */
export function detectMonorepoLayout(projectRoot: string = process.cwd()): MonorepoLayout {
  const workspaceYaml = path.join(projectRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspaceYaml)) {
    return { isMonorepo: false };
  }

  const backendDir = path.join(projectRoot, 'backend');
  const frontendDir = path.join(projectRoot, 'frontend');
  const sharedTypesDir = path.join(projectRoot, 'libs', 'shared', 'types');

  // Verify it's actually a Plumbus monorepo (backend has the app/ dir structure)
  if (!fs.existsSync(path.join(backendDir, 'package.json'))) {
    return { isMonorepo: false };
  }

  return {
    isMonorepo: true,
    backendDir,
    frontendDir,
    sharedTypesDir,
  };
}

// ── Legacy UI structure migration ──

export interface MigrationResult {
  movedFiles: string[];
  rewrittenImports: string[];
  deletedPaths: string[];
}

/** File-path mapping from legacy `generated/` layout to current `lib/` + `hooks/` layout. */
const LEGACY_FILE_MOVES: Record<string, string> = {
  'generated/client.ts': 'lib/client.ts',
  'generated/hooks.ts': 'hooks/hooks.ts',
  'generated/auth.ts': 'lib/auth.ts',
  'generated/form-hints.ts': 'lib/form-hints.ts',
};

/** Import path rewrites from legacy `@/generated/` to current paths. */
const IMPORT_REWRITES: Record<string, string> = {
  '@/generated/client': '@/lib/client',
  '@/generated/hooks': '@/hooks/hooks',
  '@/generated/auth': '@/lib/auth',
  '@/generated/form-hints': '@/lib/form-hints',
  '../generated/client': '../lib/client',
  '../generated/hooks': '../hooks/hooks',
  '../generated/auth': '../lib/auth',
  '../generated/form-hints': '../lib/form-hints',
};

/**
 * Detect and auto-migrate legacy UI generation artifacts inside `frontendDir`.
 *
 * Migrations performed:
 * 1. Move `generated/*.ts` → `lib/` + `hooks/` (delete `generated/` when empty)
 * 2. Rename `middleware.ts` → `proxy.ts` and fix the exported function name
 * 3. Delete `app/api/plumbus/[...path]/route.ts` (API proxy removed)
 * 4. Rewrite `@/generated/` imports in all `.ts`/`.tsx` files
 *
 * Returns a summary of what was changed. No-op when no legacy artifacts exist.
 */
export function migrateUiLegacyStructure(frontendDir: string): MigrationResult {
  const result: MigrationResult = { movedFiles: [], rewrittenImports: [], deletedPaths: [] };

  if (!fs.existsSync(frontendDir)) return result;

  // 1. Move generated/ files
  for (const [oldRel, newRel] of Object.entries(LEGACY_FILE_MOVES)) {
    const oldPath = path.join(frontendDir, oldRel);
    if (fs.existsSync(oldPath)) {
      const newPath = path.join(frontendDir, newRel);
      const newDir = path.dirname(newPath);
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }
      fs.renameSync(oldPath, newPath);
      result.movedFiles.push(`${oldRel} → ${newRel}`);
    }
  }

  // Remove generated/ if now empty
  const generatedDir = path.join(frontendDir, 'generated');
  if (fs.existsSync(generatedDir)) {
    const remaining = fs.readdirSync(generatedDir);
    if (remaining.length === 0) {
      fs.rmdirSync(generatedDir);
      result.deletedPaths.push('generated/');
    }
  }

  // 2. Rename middleware.ts → proxy.ts
  const middlewarePath = path.join(frontendDir, 'middleware.ts');
  if (fs.existsSync(middlewarePath)) {
    let content = fs.readFileSync(middlewarePath, 'utf-8');
    content = content.replace(/export\s+function\s+middleware\b/g, 'export function proxy');
    const proxyPath = path.join(frontendDir, 'proxy.ts');
    fs.writeFileSync(proxyPath, content, 'utf-8');
    fs.unlinkSync(middlewarePath);
    result.movedFiles.push('middleware.ts → proxy.ts');
  }

  // 3. Delete legacy API proxy route
  const proxyRoute = path.join(frontendDir, 'app', 'api', 'plumbus', '[...path]', 'route.ts');
  if (fs.existsSync(proxyRoute)) {
    fs.unlinkSync(proxyRoute);
    result.deletedPaths.push('app/api/plumbus/[...path]/route.ts');
    // Clean up empty parent dirs
    for (const dir of [
      path.join(frontendDir, 'app', 'api', 'plumbus', '[...path]'),
      path.join(frontendDir, 'app', 'api', 'plumbus'),
      path.join(frontendDir, 'app', 'api'),
    ]) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    }
  }

  // 4. Rewrite @/generated/ imports in all .ts/.tsx files
  rewriteImportsRecursive(frontendDir, result);

  return result;
}

function rewriteImportsRecursive(dir: string, result: MigrationResult): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') {
        continue;
      }
      rewriteImportsRecursive(fullPath, result);
    } else if (/\.tsx?$/.test(entry.name)) {
      const original = fs.readFileSync(fullPath, 'utf-8');
      let content = original;
      for (const [oldImport, newImport] of Object.entries(IMPORT_REWRITES)) {
        content = content.replaceAll(`"${oldImport}"`, `"${newImport}"`);
        content = content.replaceAll(`'${oldImport}'`, `'${newImport}'`);
      }
      if (content !== original) {
        fs.writeFileSync(fullPath, content, 'utf-8');
        result.rewrittenImports.push(path.relative(dir, fullPath));
      }
    }
  }
}

/** Walk up from startDir to find the nearest directory containing `.git`. */
export function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
