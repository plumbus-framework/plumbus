import { isAbsolute, relative, resolve } from 'node:path';

export class FixturePathEscapeError extends Error {
  constructor() {
    super('Test fixture path must be relative and stay within the application root');
    this.name = 'FixturePathEscapeError';
  }
}

/** Resolve a relative fixture path under appRoot; reject escapes and absolute paths. */
export function resolveContainedFixturePath(appRoot: string, fixture: string): string {
  if (isAbsolute(fixture)) {
    throw new FixturePathEscapeError();
  }

  const resolvedRoot = resolve(appRoot);
  const resolvedPath = resolve(resolvedRoot, fixture);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new FixturePathEscapeError();
  }

  return resolvedPath;
}
