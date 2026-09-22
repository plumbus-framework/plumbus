#!/usr/bin/env node
/**
 * Compile-time regression for catalog translation typing
 * (`MessageArgsOf` / `TranslateValuesArgs` / `TranslationsFor`).
 *
 * catalog-typing.ts must typecheck clean: positive calls accept,
 * negatives are marked with @ts-expect-error (unused directive = weakened rules).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'typecheck-fixtures');

const result = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', join(fixtures, 'tsconfig.json')], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const status = result.status ?? 1;
const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (status !== 0) {
  console.error(`check-catalog-translation-types: fixtures must typecheck clean:\n${combined}`);
  process.exit(1);
}

console.log('check-catalog-translation-types: ok');
