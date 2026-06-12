import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanCapabilityDirectImports } from '../capability-source-scan.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeCapabilitySource(appRoot: string, relPath: string, content: string): void {
  const fullPath = path.join(appRoot, 'app', 'capabilities', relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

describe('scanCapabilityDirectImports', () => {
  it('returns no signals when capability directory is missing', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-scan-'));
    tempDirs.push(appRoot);
    expect(scanCapabilityDirectImports(appRoot)).toEqual([]);
  });

  it('flags direct capability module imports', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-scan-'));
    tempDirs.push(appRoot);
    writeCapabilitySource(
      appRoot,
      'orders/create-order.ts',
      `import { otherCap } from '../../capabilities/billing/charge-card.js';\nexport const x = otherCap;\n`,
    );

    const signals = scanCapabilityDirectImports(appRoot);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('architecture.direct-capability-handler-import');
  });

  it('flags direct .handler access in capability modules', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-scan-'));
    tempDirs.push(appRoot);
    writeCapabilitySource(
      appRoot,
      'orders/create-order.ts',
      `const result = await otherCap.handler(ctx, input);\n`,
    );

    const signals = scanCapabilityDirectImports(appRoot);
    expect(signals.some((s) => s.description.includes('.handler'))).toBe(true);
  });

  it('flags executeCapability calls in application capability modules', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-scan-'));
    tempDirs.push(appRoot);
    writeCapabilitySource(
      appRoot,
      'orders/create-order.ts',
      `import { executeCapability } from '@plumbus/core';\nexecuteCapability(cap, ctx, {});\n`,
    );

    const signals = scanCapabilityDirectImports(appRoot);
    expect(signals.some((s) => s.description.includes('executeCapability'))).toBe(true);
  });
});
