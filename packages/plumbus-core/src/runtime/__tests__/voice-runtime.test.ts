import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadVoiceRuntime } from '../voice-runtime.js';

const roots: string[] = [];
async function fixture(source?: string, extension = 'js') {
  const root = await mkdtemp(join(tmpdir(), 'plumbus-voice-runtime-'));
  roots.push(root);
  await mkdir(join(root, 'app/voice'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  if (source) await writeFile(join(root, `app/voice/runtime.${extension}`), source);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const valid = `export const voiceRuntime = {
  resources: { capabilities: [], entities: [], events: [], prompts: [] },
  extensions: { onAICostRecorded: async () => {}, enableStrictStructuredOutputs: true }
};`;

describe('voice runtime module', () => {
  it('returns null only when the opt-in module is absent', async () => {
    expect(await loadVoiceRuntime(await fixture())).toBeNull();
  });

  it.each([
    'js',
    'ts',
  ])('loads explicit %s resources without importing app/server or other features', async (extension) => {
    const root = await fixture(valid, extension);
    await writeFile(join(root, 'app/server.js'), 'throw new Error("must not load server");');
    await mkdir(join(root, 'app/capabilities'));
    await writeFile(
      join(root, 'app/capabilities/unrelated.js'),
      'throw new Error("must not scan");',
    );
    const config = await loadVoiceRuntime(root);
    expect(config?.resources.capabilities).toEqual([]);
    expect(config?.extensions.onAICostRecorded).toBeTypeOf('function');
    expect(config?.extensions.enableStrictStructuredOutputs).toBe(true);
  });

  it.each([
    'export const voiceRuntime = {};',
    valid.replace('capabilities: []', 'capabilities: "all"'),
    valid.replace('async () => {}', 'true'),
    valid.replace('extensions:', 'serverExtensions:'),
  ])('fails closed for an invalid explicit module', async (source) => {
    await expect(loadVoiceRuntime(await fixture(source))).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('propagates import failures instead of falling back to full discovery', async () => {
    await expect(
      loadVoiceRuntime(await fixture('throw new Error("broken voice module");')),
    ).rejects.toThrow('broken voice module');
  });
});
