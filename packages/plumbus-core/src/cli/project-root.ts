import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorHints } from '../errors/hints.js';

const PROJECT_MARKERS = [
  'config/app.config.ts',
  'plumbus.config.ts',
  'plumbus.config.json',
] as const;

/** Return true when cwd looks like a Plumbus application project. */
export function isPlumbusProjectRoot(cwd: string = process.cwd()): boolean {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(cwd, marker)));
}

/** Find project root by walking up from cwd, or undefined if not found. */
export function findPlumbusProjectRoot(startDir: string = process.cwd()): string | undefined {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 32; depth += 1) {
    if (isPlumbusProjectRoot(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve a user-supplied path and ensure it stays within the project root.
 */
export function resolvePathWithinProject(
  userPath: string,
  projectRoot: string = findPlumbusProjectRoot() ?? process.cwd(),
): string {
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(projectRoot, userPath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${ErrorHints.pathOutsideProject} (${projectRoot}): ${userPath}`);
  }
  return resolved;
}
