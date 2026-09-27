// Links the workspace's built packages into this app's node_modules (symlinks
// only — nothing is downloaded), the way a consumer app links local packages.
// Idempotent. Run after `pnpm build` at the repo root.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

export const appRoot = path.resolve(import.meta.dirname, '..');
export const repoRoot = path.resolve(appRoot, '../..');

const links = {
  '@plumbus/core': 'packages/plumbus-core',
  '@plumbus/payments': 'packages/payments',
  '@plumbus/payments-stripe': 'packages/payments-stripe',
  // Only for typechecking the app; resolved through the payments package's install.
  '@types/node': 'packages/payments/node_modules/@types/node',
};

export function linkPackages({ quiet = false } = {}) {
  for (const [name, dir] of Object.entries(links)) {
    const target = path.join(repoRoot, dir);
    if (name.startsWith('@plumbus/') && !existsSync(path.join(target, 'dist/index.js'))) {
      throw new Error(`${name} is not built (${dir}/dist missing). Run \`pnpm build\` at the repo root.`);
    }
    const link = path.join(appRoot, 'node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    const relative = path.relative(path.dirname(link), target);
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === relative) continue;
      rmSync(link, { recursive: true, force: true });
    }
    symlinkSync(relative, link, 'dir');
    if (!quiet) console.log(`linked ${name} → ${dir}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  linkPackages();
}
