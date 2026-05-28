import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPlumbusProjectRoot, resolvePathWithinProject } from '../project-root.js';

describe('project-root', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('detects config/app.config.ts marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-root-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'app.config.ts'), 'export default {}');
    expect(isPlumbusProjectRoot(root)).toBe(true);
  });

  it('rejects paths outside project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-root-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'app.config.ts'), 'export default {}');

    const outside = path.join(path.dirname(root), 'plumbus-outside-file.txt');
    expect(() => resolvePathWithinProject(outside, root)).toThrow(/under project root/);
  });
});
