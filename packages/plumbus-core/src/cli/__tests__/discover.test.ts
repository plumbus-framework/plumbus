import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverResources, hasAppDirectory } from '../discover.js';

describe('discoverResources', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-discover-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('returns empty when app/ directory does not exist', async () => {
    const root = makeTmpDir();
    const result = await discoverResources(root);
    expect(result.capabilities).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.flows).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.prompts).toEqual([]);
    expect(result.schemas).toEqual({});
  });

  it('hasAppDirectory returns false when app/ missing', () => {
    const root = makeTmpDir();
    expect(hasAppDirectory(root)).toBe(false);
  });

  it('hasAppDirectory returns true when app/ exists', () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, 'app'));
    expect(hasAppDirectory(root)).toBe(true);
  });

  it('returns empty arrays when app/ subdirs are empty', async () => {
    const root = makeTmpDir();
    const dirs = ['capabilities', 'entities', 'flows', 'events', 'prompts'];
    for (const d of dirs) {
      fs.mkdirSync(path.join(root, 'app', d), { recursive: true });
    }
    const result = await discoverResources(root);
    expect(result.capabilities).toEqual([]);
    expect(result.entities).toEqual([]);
  });
  it('expands exported collections of resources and counts each resource once', async () => {
    const root = makeTmpDir();
    const dir = path.join(root, 'app', 'capabilities');
    fs.mkdirSync(dir, { recursive: true });
    const capability = (name: string) =>
      `{ name: '${name}', kind: 'action', domain: 'addon', handler() {}, effects: { data: [], events: [], external: [], ai: false } }`;
    fs.writeFileSync(
      path.join(dir, 'addon.js'),
      [
        `const one = ${capability('one')};`,
        `export const addonCapabilities = Object.freeze({ one, two: ${capability('two')} });`,
        `export const more = [${capability('three')}];`,
        'export { one };',
        // A named object is a resource candidate itself, never a collection.
        `export const settings = { name: 'settings', nested: ${capability('hidden')} };`,
      ].join('\n'),
    );
    const result = await discoverResources(root);
    expect(result.capabilities.map((c) => c.name).sort()).toEqual(['one', 'three', 'two']);
  });

  it('discovers nested decision definitions and snapshots their questions', async () => {
    const root = makeTmpDir();
    const dir = path.join(root, 'app', 'decisions', 'billing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'refund.js'),
      `export default {kind: 'decision', name: 'billing.refund', questions: {refund: {type: 'probability', instructions: 'Refund?'}}};`,
    );
    const result = await discoverResources(root);
    expect(result.decisions?.map((decision) => decision.name)).toEqual(['billing.refund']);
    expect(Object.isFrozen(result.decisions?.[0])).toBe(true);
  });

  it('fails explicitly when a decision module cannot load', async () => {
    const root = makeTmpDir();
    const dir = path.join(root, 'app', 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'invalid.js'), 'throw new Error("secret contents");');
    await expect(discoverResources(root)).rejects.toThrow(
      'Unable to load decision module: invalid.js',
    );
  });
});
