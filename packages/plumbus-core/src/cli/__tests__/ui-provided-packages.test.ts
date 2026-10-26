import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkUiDependencies } from '../commands/doctor.js';
import {
  checkUiProvidedPackages,
  lockfileVersions,
  UI_PROVIDED_PACKAGES,
} from '../ui-provided-packages.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOIST = `publicHoistPattern:\n${UI_PROVIDED_PACKAGES.map((name) => `  - '${name}'`).join('\n')}\n`;

function project(options: {
  workspace?: string;
  rootManifest?: Record<string, unknown>;
  frontendManifest?: Record<string, unknown>;
  uiManifest?: Record<string, unknown> | null;
  lockfile?: string;
  npmrc?: string;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'plumbus-ui-deps-'));
  roots.push(root);
  writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    options.workspace ?? `packages:\n  - frontend\n\n${HOIST}`,
  );
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(options.rootManifest ?? { name: 'app' }),
  );
  mkdirSync(path.join(root, 'frontend'));
  writeFileSync(
    path.join(root, 'frontend', 'package.json'),
    JSON.stringify(
      options.frontendManifest ?? { name: 'frontend', dependencies: { '@plumbus/ui': '0.10.0' } },
    ),
  );
  if (options.uiManifest !== null) {
    const uiDir = path.join(root, 'node_modules', '@plumbus', 'ui');
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(
      path.join(uiDir, 'package.json'),
      JSON.stringify(
        options.uiManifest ?? { name: '@plumbus/ui', dependencies: { next: '^16.4.3' } },
      ),
    );
  }
  if (options.lockfile !== undefined)
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), options.lockfile);
  if (options.npmrc !== undefined) writeFileSync(path.join(root, '.npmrc'), options.npmrc);
  return root;
}

const LOCK_ONE = `lockfileVersion: '9.0'

importers:

  .: {}

packages:

  next@16.4.3:
    resolution: {integrity: sha512-x}

  '@types/react@19.2.14':
    resolution: {integrity: sha512-y}

snapshots:

  next@16.4.3(react@19.2.8):
    dependencies: {}
`;

describe('plumbus ui deps', () => {
  it('passes when the app declares none of them, hoists all and locks one version each', () => {
    const report = checkUiProvidedPackages(project({ lockfile: LOCK_ONE }));
    expect(report).toEqual({ status: 'ok', provided: [...UI_PROVIDED_PACKAGES], issues: [] });
  });

  it('skips an app without @plumbus/ui', () => {
    expect(checkUiProvidedPackages(project({ uiManifest: null })).status).toBe('skip');
  });

  it('refuses a workspace manifest that declares a supplied package', () => {
    const report = checkUiProvidedPackages(
      project({
        frontendManifest: {
          dependencies: { '@plumbus/ui': '0.10.0', next: '^16.3.8' },
          devDependencies: { typescript: '^5.7.0' },
        },
        rootManifest: { devDependencies: { '@types/react': '^19.0.0' } },
      }),
    );
    expect(report.status).toBe('fail');
    expect(report.issues).toEqual([
      'package.json declares @types/react in devDependencies; @plumbus/ui supplies it — remove it',
      'frontend/package.json declares next in dependencies; @plumbus/ui supplies it — remove it',
      'frontend/package.json declares typescript in devDependencies; @plumbus/ui supplies it — remove it',
    ]);
  });

  it('refuses a supplied package pnpm does not hoist', () => {
    const report = checkUiProvidedPackages(project({ workspace: 'packages:\n  - frontend\n' }));
    expect(report.status).toBe('fail');
    expect(report.issues).toHaveLength(UI_PROVIDED_PACKAGES.length);
    expect(report.issues[0]).toBe(
      'next is not in publicHoistPattern (pnpm-workspace.yaml), so the app cannot import it',
    );
  });

  it('accepts hoisting from .npmrc and glob patterns', () => {
    const report = checkUiProvidedPackages(
      project({
        workspace: 'packages:\n  - frontend\n',
        npmrc: 'public-hoist-pattern[]=*\n',
      }),
    );
    expect(report.status).toBe('ok');
  });

  it('refuses two locked versions of a supplied package', () => {
    const lockfile = LOCK_ONE.replace(
      '  next@16.4.3:\n',
      '  next@16.3.8:\n    resolution: {integrity: sha512-z}\n\n  next@16.4.3:\n',
    );
    const report = checkUiProvidedPackages(project({ lockfile }));
    expect(report.issues).toEqual([
      'pnpm-lock.yaml holds 2 versions of next (16.3.8, 16.4.3); one copy must serve the app',
    ]);
  });

  it('takes the supplied list from the installed @plumbus/ui manifest when it names one', () => {
    const report = checkUiProvidedPackages(
      project({
        workspace: 'packages:\n  - frontend\n\npublicHoistPattern:\n  - next\n',
        uiManifest: { name: '@plumbus/ui', plumbus: { provides: ['next'] } },
      }),
    );
    expect(report).toEqual({ status: 'ok', provided: ['next'], issues: [] });
  });

  it('reads package versions from the packages section only', () => {
    const versions = lockfileVersions(LOCK_ONE);
    expect([...(versions.get('next') ?? [])]).toEqual(['16.4.3']);
    expect([...(versions.get('@types/react') ?? [])]).toEqual(['19.2.14']);
  });

  it('is part of plumbus doctor', () => {
    const failing = checkUiDependencies(project({ workspace: 'packages:\n  - frontend\n' }));
    expect(failing.status).toBe('warn');
    expect(checkUiDependencies(project({})).status).toBe('ok');
  });
});
