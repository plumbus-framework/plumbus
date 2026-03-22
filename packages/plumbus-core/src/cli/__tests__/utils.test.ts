import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandRequiresProject,
  detectMonorepoLayout,
  findPlumbusProjectRoot,
  formatOutput,
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
