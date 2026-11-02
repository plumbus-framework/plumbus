import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Runs the built module in a plain Node process: vitest's own resolver would load the
// TypeScript helper even without tsx and hide the regression this guards.
const built = fileURLToPath(new URL('../../../dist/discover/discover-voices.js', import.meta.url));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function appWithJsVoiceUsingTsHelper() {
  const root = await mkdtemp(join(tmpdir(), 'plumbus-voices-'));
  directories.push(root);
  await mkdir(join(root, 'app/voices'), { recursive: true });
  await mkdir(join(root, 'app/shared'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
  await writeFile(
    join(root, 'app/shared/helper.ts'),
    `export const voiceName: string = 'interviewer';`,
  );
  await writeFile(
    join(root, 'app/voices/interviewer.js'),
    `import { voiceName } from '../shared/helper.js';\nexport const interviewer = { kind: 'voice', name: voiceName };`,
  );
  return root;
}

function discoveredNames(appRoot: string): string[] {
  const script = `const { discoverVoices } = await import(${JSON.stringify(pathToFileURL(built).href)});
const voices = await discoverVoices({ appRoot: ${JSON.stringify(appRoot)} });
process.stdout.write(JSON.stringify(voices.map((voice) => voice.name)));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as string[];
}

describe('discoverVoices outside compiled mode', () => {
  it('loads a .js voice that imports a TypeScript helper, as voice 0.6.0 did', async () => {
    expect(discoveredNames(await appWithJsVoiceUsingTsHelper())).toEqual(['interviewer']);
  });
});
