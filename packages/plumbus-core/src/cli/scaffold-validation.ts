import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { createErrorService } from '../errors/index.js';

export function assertScaffoldName(name: string): void {
  if (
    !z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*(?:[ _-][A-Za-z0-9]+)*$/)
      .safeParse(name).success
  ) {
    throw createErrorService().validation(
      'Invalid scaffold name: use letters, numbers, spaces, hyphens, or underscores',
    );
  }
}

export function assertPathSegment(value: string): void {
  if (
    !z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .refine((part) => !part.includes('..'))
      .safeParse(value).success
  ) {
    throw createErrorService().validation('Invalid generated path segment');
  }
}

/** Reject existing symlinks, including dangling links, anywhere on a write path. */
export function assertNoSymlinkPath(target: string): void {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw createErrorService().validation('Generated writes cannot follow symlinks');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function resolveGeneratedPath(outputRoot: string, filePath: string): string {
  const components = filePath.replaceAll('\\', '/').split('/');
  if (
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    components.includes('..') ||
    filePath.includes('\0')
  ) {
    throw createErrorService().validation('Generated path must stay within its output directory');
  }
  const resolved = path.resolve(outputRoot, filePath);
  const relative = path.relative(path.resolve(outputRoot), resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw createErrorService().validation('Generated path must stay within its output directory');
  assertNoSymlinkPath(resolved);
  return resolved;
}
