import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanForbiddenPaths } from '../forbidden-path-scan.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeAppSource(appRoot: string, relPath: string, content: string): void {
  const fullPath = path.join(appRoot, 'app', relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

describe('scanForbiddenPaths', () => {
  it('returns no signals when app/ is missing', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-forbidden-'));
    tempDirs.push(appRoot);
    expect(scanForbiddenPaths(appRoot)).toEqual([]);
  });

  it('flags a direct postgres import', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-forbidden-'));
    tempDirs.push(appRoot);
    writeAppSource(appRoot, 'billing/store.ts', `import postgres from 'postgres';\n`);
    const signals = scanForbiddenPaths(appRoot);
    expect(signals.some((s) => s.rule === 'architecture.forbidden-raw-sql-import')).toBe(true);
    expect(signals[0]?.severity).toBe('high');
  });

  it('flags createExecutionContext in application code', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-forbidden-'));
    tempDirs.push(appRoot);
    writeAppSource(
      appRoot,
      'billing/mint.ts',
      `import { createExecutionContext } from '@plumbus/core/runtime';\ncreateExecutionContext({ auth, data: {} });\n`,
    );
    expect(
      scanForbiddenPaths(appRoot).some(
        (s) => s.rule === 'architecture.forbidden-create-execution-context',
      ),
    ).toBe(true);
  });

  it('flags a parallel queue import', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-forbidden-'));
    tempDirs.push(appRoot);
    writeAppSource(appRoot, 'jobs/runner.ts', `import { Queue } from 'bullmq';\n`);
    expect(
      scanForbiddenPaths(appRoot).some((s) => s.rule === 'architecture.forbidden-parallel-queue'),
    ).toBe(true);
  });

  it('flags a raw provider API key read', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-forbidden-'));
    tempDirs.push(appRoot);
    writeAppSource(
      appRoot,
      'ai/keys.ts',
      `const key = process.env.OPENAI_API_KEY;\nexport const k = key;\n`,
    );
    expect(
      scanForbiddenPaths(appRoot).some(
        (s) => s.rule === 'architecture.forbidden-raw-provider-credential',
      ),
    ).toBe(true);
  });

  it('ignores test files', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-forbidden-'));
    tempDirs.push(appRoot);
    writeAppSource(appRoot, 'billing/store.test.ts', `import postgres from 'postgres';\n`);
    expect(scanForbiddenPaths(appRoot)).toEqual([]);
  });
});
