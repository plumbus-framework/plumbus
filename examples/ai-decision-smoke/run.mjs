#!/usr/bin/env node
// One command builds the packages, starts a local model, and checks both adapters.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const command = process.argv[2] ?? 'run';
const packages = ['plumbus-core', 'ai-decision', 'ai-decision-laya', 'ai-decision-typesafe'];
if (
  ['run', 'start', 'restart'].includes(command) ||
  packages.some(
    (name) => !existsSync(new URL(`../../packages/${name}/dist/index.js`, import.meta.url)),
  )
) {
  const build = spawnSync(
    'pnpm',
    ['--filter', '@plumbus/core', '--filter', '@plumbus/ai-decision*', 'build'],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (build.error || build.status !== 0) {
    console.error('Framework build failed. Run pnpm install from the repository root, then retry.');
    process.exit(build.status ?? 1);
  }
}

try {
  const { runCommand } = await import('./lib/control.mjs');
  await runCommand(command, process.argv.slice(3).join(' ') || undefined);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke app failed');
  process.exitCode = 1;
}
