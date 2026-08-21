import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist', '.plumbus']);

/** Application TypeScript/JavaScript sources under `dir`, skipping tests and build output. */
export function listApplicationSourceFiles(dir: string): string[] {
  const results: string[] = [];
  walk(dir, results);
  return results;
}

function walk(dir: string, results: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(fullPath, results);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.ts') && !ent.name.endsWith('.js')) continue;
    if (
      ent.name.endsWith('.test.ts') ||
      ent.name.endsWith('.test.js') ||
      ent.name.endsWith('.d.ts')
    ) {
      continue;
    }
    results.push(fullPath);
  }
}
