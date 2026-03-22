import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandRequiresProject,
  detectMonorepoLayout,
  findPlumbusProjectRoot,
  formatOutput,
  migrateUiLegacyStructure,
  toCamelCase,
  toKebabCase,
  toPascalCase,
} from '../utils.js';

describe('CLI utilities', () => {
  describe('toKebabCase', () => {
    it('converts PascalCase', () => expect(toKebabCase('MyApp')).toBe('my-app'));
    it('converts camelCase', () => expect(toKebabCase('myApp')).toBe('my-app'));
    it('converts spaces', () => expect(toKebabCase('My App')).toBe('my-app'));
    it('converts underscores', () => expect(toKebabCase('my_app')).toBe('my-app'));
    it('handles already kebab', () => expect(toKebabCase('my-app')).toBe('my-app'));
  });

  describe('toPascalCase', () => {
    it('converts kebab-case', () => expect(toPascalCase('my-app')).toBe('MyApp'));
    it('converts snake_case', () => expect(toPascalCase('my_app')).toBe('MyApp'));
    it('converts spaces', () => expect(toPascalCase('my app')).toBe('MyApp'));
  });

  describe('toCamelCase', () => {
    it('converts kebab-case', () => expect(toCamelCase('my-app')).toBe('myApp'));
    it('converts PascalCase', () => expect(toCamelCase('MyApp')).toBe('myApp'));
  });

  describe('formatOutput', () => {
    it('returns JSON when json option is true', () => {
      const result = formatOutput({ foo: 'bar' }, { json: true });
      expect(JSON.parse(result)).toEqual({ foo: 'bar' });
    });

    it('returns string directly', () => {
      expect(formatOutput('hello', {})).toBe('hello');
    });
  });
});

describe('findPlumbusProjectRoot', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-guard-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('returns undefined when no package.json exists', () => {
    const dir = makeTmpDir();
    expect(findPlumbusProjectRoot(dir)).toBeUndefined();
  });

  it('returns undefined when package.json has no @plumbus/core', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'some-app', dependencies: {} }),
    );
    expect(findPlumbusProjectRoot(dir)).toBeUndefined();
  });

  it('finds project root with @plumbus/core in dependencies', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-app', dependencies: { '@plumbus/core': '^0.1.0' } }),
    );
    expect(findPlumbusProjectRoot(dir)).toBe(dir);
  });

  it('finds project root with @plumbus/core in devDependencies', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-app', devDependencies: { '@plumbus/core': '^0.1.0' } }),
    );
    expect(findPlumbusProjectRoot(dir)).toBe(dir);
  });

  it('walks up to find project root from a subdirectory', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-app', dependencies: { '@plumbus/core': '^0.1.0' } }),
    );
    const sub = path.join(dir, 'app', 'entities');
    fs.mkdirSync(sub, { recursive: true });
    expect(findPlumbusProjectRoot(sub)).toBe(dir);
  });

  it('skips malformed package.json', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{ broken json');
    expect(findPlumbusProjectRoot(dir)).toBeUndefined();
  });
});

describe('commandRequiresProject', () => {
  it('returns false for create', () => {
    expect(commandRequiresProject('create')).toBe(false);
  });

  it('returns false for doctor', () => {
    expect(commandRequiresProject('doctor')).toBe(false);
  });

  it('returns false for init', () => {
    expect(commandRequiresProject('init')).toBe(false);
  });

  it('returns true for entity', () => {
    expect(commandRequiresProject('entity')).toBe(true);
  });

  it('returns true for migrate', () => {
    expect(commandRequiresProject('migrate')).toBe(true);
  });

  it('returns true for generate', () => {
    expect(commandRequiresProject('generate')).toBe(true);
  });
});

describe('detectMonorepoLayout', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-mono-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('returns isMonorepo false when no pnpm-workspace.yaml', () => {
    const dir = makeTmpDir();
    expect(detectMonorepoLayout(dir)).toEqual({ isMonorepo: false });
  });

  it('returns isMonorepo false when workspace exists but no backend package.json', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "backend"\n');
    expect(detectMonorepoLayout(dir)).toEqual({ isMonorepo: false });
  });

  it('detects a valid monorepo layout', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "backend"\n');
    const backendDir = path.join(dir, 'backend');
    fs.mkdirSync(backendDir, { recursive: true });
    fs.writeFileSync(path.join(backendDir, 'package.json'), '{}');

    const result = detectMonorepoLayout(dir);
    expect(result.isMonorepo).toBe(true);
    expect(result.backendDir).toBe(backendDir);
    expect(result.frontendDir).toBe(path.join(dir, 'frontend'));
    expect(result.sharedTypesDir).toBe(path.join(dir, 'libs', 'shared', 'types'));
  });
});

describe('migrateUiLegacyStructure', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrate-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('returns empty result when frontend dir does not exist', () => {
    const result = migrateUiLegacyStructure('/does/not/exist');
    expect(result.movedFiles).toEqual([]);
    expect(result.rewrittenImports).toEqual([]);
    expect(result.deletedPaths).toEqual([]);
  });

  it('is a no-op when no legacy artifacts exist', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'client.ts'), 'export {}');
    const result = migrateUiLegacyStructure(dir);
    expect(result.movedFiles).toEqual([]);
    expect(result.deletedPaths).toEqual([]);
  });

  it('moves generated/ files to lib/ and hooks/', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'generated', 'client.ts'), 'export const client = {}');
    fs.writeFileSync(path.join(dir, 'generated', 'hooks.ts'), 'export const hooks = {}');
    fs.writeFileSync(path.join(dir, 'generated', 'auth.ts'), 'export const auth = {}');
    fs.writeFileSync(path.join(dir, 'generated', 'form-hints.ts'), 'export const hints = {}');

    const result = migrateUiLegacyStructure(dir);
    expect(result.movedFiles).toContain('generated/client.ts → lib/client.ts');
    expect(result.movedFiles).toContain('generated/hooks.ts → hooks/hooks.ts');
    expect(result.movedFiles).toContain('generated/auth.ts → lib/auth.ts');
    expect(result.movedFiles).toContain('generated/form-hints.ts → lib/form-hints.ts');

    // New files exist
    expect(fs.existsSync(path.join(dir, 'lib', 'client.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'hooks', 'hooks.ts'))).toBe(true);

    // Old dir removed
    expect(fs.existsSync(path.join(dir, 'generated'))).toBe(false);
    expect(result.deletedPaths).toContain('generated/');
  });

  it('keeps generated/ if it still has other files', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'generated', 'client.ts'), 'export {}');
    fs.writeFileSync(path.join(dir, 'generated', 'custom.ts'), 'export {}');

    const result = migrateUiLegacyStructure(dir);
    expect(result.movedFiles).toContain('generated/client.ts → lib/client.ts');
    expect(fs.existsSync(path.join(dir, 'generated'))).toBe(true);
    expect(result.deletedPaths).not.toContain('generated/');
  });

  it('renames middleware.ts to proxy.ts and fixes export', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'middleware.ts'),
      'export function middleware(request: NextRequest) { return NextResponse.next(); }',
    );

    const result = migrateUiLegacyStructure(dir);
    expect(result.movedFiles).toContain('middleware.ts → proxy.ts');
    expect(fs.existsSync(path.join(dir, 'middleware.ts'))).toBe(false);

    const content = fs.readFileSync(path.join(dir, 'proxy.ts'), 'utf-8');
    expect(content).toContain('export function proxy(request: NextRequest)');
    expect(content).not.toContain('export function middleware');
  });

  it('deletes legacy API proxy route and cleans up empty dirs', () => {
    const dir = makeTmpDir();
    const routeDir = path.join(dir, 'app', 'api', 'plumbus', '[...path]');
    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, 'route.ts'), 'export async function POST() {}');

    const result = migrateUiLegacyStructure(dir);
    expect(result.deletedPaths).toContain('app/api/plumbus/[...path]/route.ts');
    expect(fs.existsSync(routeDir)).toBe(false);
    // app/ dir should still exist (it has other uses)
    expect(fs.existsSync(path.join(dir, 'app'))).toBe(true);
  });

  it('rewrites @/generated/ imports in .ts and .tsx files', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'app', 'dashboard'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'app', 'dashboard', 'page.tsx'),
      `import { getUser } from "@/generated/client";\nimport { useGetUser } from "@/generated/hooks";\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'app', 'utils.ts'),
      `import { login } from '@/generated/auth';\n`,
    );

    const result = migrateUiLegacyStructure(dir);
    expect(result.rewrittenImports.length).toBeGreaterThan(0);

    const page = fs.readFileSync(path.join(dir, 'app', 'dashboard', 'page.tsx'), 'utf-8');
    expect(page).toContain('@/lib/client');
    expect(page).toContain('@/hooks/hooks');
    expect(page).not.toContain('@/generated/');

    const utils = fs.readFileSync(path.join(dir, 'app', 'utils.ts'), 'utf-8');
    expect(utils).toContain('@/lib/auth');
  });

  it('skips node_modules when rewriting imports', () => {
    const dir = makeTmpDir();
    const nmDir = path.join(dir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.ts'), `import { x } from "@/generated/client";\n`);

    const result = migrateUiLegacyStructure(dir);
    expect(result.rewrittenImports).toEqual([]);
    // node_modules file unchanged
    const content = fs.readFileSync(path.join(nmDir, 'index.ts'), 'utf-8');
    expect(content).toContain('@/generated/client');
  });

  it('handles all migrations together', () => {
    const dir = makeTmpDir();

    // Legacy generated/ files
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'generated', 'client.ts'), 'export {}');

    // Legacy middleware
    fs.writeFileSync(path.join(dir, 'middleware.ts'), 'export function middleware() {}');

    // Legacy API proxy
    const routeDir = path.join(dir, 'app', 'api', 'plumbus', '[...path]');
    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, 'route.ts'), 'export {}');

    // File with legacy imports
    fs.mkdirSync(path.join(dir, 'app', 'home'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'app', 'home', 'page.tsx'),
      `import { x } from "@/generated/client";\n`,
    );

    const result = migrateUiLegacyStructure(dir);
    expect(result.movedFiles.length).toBeGreaterThanOrEqual(2);
    expect(result.deletedPaths.length).toBeGreaterThanOrEqual(1);
    expect(result.rewrittenImports.length).toBeGreaterThanOrEqual(1);
  });
});
