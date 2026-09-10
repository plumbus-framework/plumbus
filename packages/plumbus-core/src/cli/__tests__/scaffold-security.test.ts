import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateProjectStructure } from '../commands/create.js';
import { translationTemplate, localeFolderTranslationTemplate } from '../templates/resources.js';
import { writeGeneratedFiles, writeScaffoldFiles } from '../scaffold-write.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-security-'));
  roots.push(root);
  return root;
}

describe('scaffold security', () => {
  it.each([
    '../escape',
    'x";import("evil")',
    'x\nINJECT=1',
    'x/evil',
    'x\\evil',
  ])('rejects unsafe names and flags: %s', (payload) => {
    for (const monorepo of [false, true]) {
      expect(() => generateProjectStructure(payload, { monorepo })).toThrow('Invalid scaffold');
      for (const flag of ['auth', 'ai', 'compliance'])
        expect(() => generateProjectStructure('safe', { [flag]: payload, monorepo })).toThrow(
          'Invalid scaffold',
        );
    }
    expect(() => translationTemplate(payload)).toThrow('Invalid scaffold');
    expect(() => localeFolderTranslationTemplate(payload)).toThrow('Invalid scaffold');
  });
  it.each([
    '../escape.txt',
    '/tmp/escape.txt',
    'C:\\escape.txt',
    '..\\escape.txt',
  ])('contains generated paths: %s', (file) => {
    const root = temp();
    expect(() => writeGeneratedFiles(root, [{ path: file, content: 'bad' }])).toThrow(
      'within its output',
    );
  });
  it('rejects symlinks and preserves existing scaffolds while writing safe files', () => {
    const root = temp();
    const outside = temp();
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(() => writeGeneratedFiles(root, [{ path: 'link/escape', content: 'bad' }])).toThrow(
      'symlinks',
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    writeScaffoldFiles(root, [{ path: 'safe/file.ts', content: 'first' }]);
    expect(
      writeScaffoldFiles(root, [{ path: 'safe/file.ts', content: 'second' }]).skipped,
    ).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'safe/file.ts'), 'utf8')).toBe('first');
  });
});
