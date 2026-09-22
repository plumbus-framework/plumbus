import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const srcRoot = join(import.meta.dirname, '..');

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('no direct vector store imports (K15)', () => {
  it('does not import @plumbus/core vector store modules from knowledge-base src', () => {
    const forbidden = [
      'createInMemoryVectorStore',
      'documentsTable',
      'documentChunksTable',
      '/vector/',
    ];
    const violations: string[] = [];
    for (const file of collectTsFiles(srcRoot)) {
      const content = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        if (content.includes(token)) {
          violations.push(`${file}: ${token}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
