// ── Shared scaffold file writers (ui nextjs + browser-extension) ──

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGeneratedPath } from './scaffold-validation.js';
import { writeFile } from './utils.js';

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface ScaffoldWriteResult {
  written: string[];
  skipped: string[];
  overwritten: string[];
}

/** Always write generated contract files (overwrite existing). */
export function writeGeneratedFiles(outputRoot: string, files: GeneratedFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const fullPath = resolveGeneratedPath(outputRoot, file.path);
    writeFile(fullPath, file.content);
    written.push(path.join(outputRoot, file.path));
  }
  return written;
}

/**
 * Write scaffold/template files with overwrite protection.
 * Files that already exist on disk are skipped unless `force` is true.
 */
export function writeScaffoldFiles(
  outputRoot: string,
  files: GeneratedFile[],
  force?: boolean,
): ScaffoldWriteResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const overwritten: string[] = [];

  for (const file of files) {
    const fullPath = resolveGeneratedPath(outputRoot, file.path);
    const existed = fs.existsSync(fullPath);
    if (!force && existed) {
      skipped.push(path.join(outputRoot, file.path));
    } else {
      try {
        writeFile(fullPath, file.content, !force);
      } catch (error) {
        if (!force && (error as NodeJS.ErrnoException).code === 'EEXIST') {
          skipped.push(fullPath);
          continue;
        }
        throw error;
      }
      const rel = path.join(outputRoot, file.path);
      written.push(rel);
      if (existed && force) {
        overwritten.push(rel);
      }
    }
  }

  return { written, skipped, overwritten };
}
