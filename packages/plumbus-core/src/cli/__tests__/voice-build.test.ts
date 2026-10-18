import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVoiceApplication } from '../voice-build.js';

const roots: string[] = [];
const coreRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageUrl = (file: string) => pathToFileURL(join(coreRoot, file)).href;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plumbus-compiled-voice-'));
  roots.push(root);
  for (const directory of ['app/voice', 'app/voices', 'config', 'node_modules/@plumbus']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { '@plumbus/core': '*' } }),
  );
  await symlink(coreRoot, join(root, 'node_modules/@plumbus/core'));
  await symlink(join(dirname(coreRoot), 'voice'), join(root, 'node_modules/@plumbus/voice'));
  await writeFile(
    join(root, 'app/voice/registry.ts'),
    `
    import { createProviderRegistry } from '@plumbus/voice';
    export const voiceProviderRegistry = createProviderRegistry();
  `,
  );
  await writeFile(
    join(root, 'app/voice/runtime.ts'),
    `
    import { defineCapability } from '@plumbus/core';
    import { z } from '@plumbus/core/zod';
    const capability = defineCapability({
      name: 'probe', domain: 'interview', kind: 'query',
      input: z.object({}), output: z.string(), access: { roles: ['user'] },
      effects: { data: [], events: [], external: [], ai: false }, handler: async () => 'ok',
    });
    export const voiceRuntime = {
      resources: { capabilities: [capability], entities: [], events: [], prompts: [] },
      extensions: {},
    };
  `,
  );
  await writeFile(
    join(root, 'app/voices/probe.ts'),
    `
    import { defineVoice } from '@plumbus/voice';
    export const probe = defineVoice({
      name: 'probe', access: { roles: ['user'] }, transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' }, tts: { provider: 'browser-tts' },
      brain: { run: async () => ({ text: 'ok' }) },
    });
  `,
  );
  await writeFile(
    join(root, 'config/app.config.ts'),
    `
    const environment: 'production' = 'production';
    export const config = { environment };
  `,
  );
  // Existence alone must not cause discovery/import of unrelated server features.
  await writeFile(join(root, 'app/server.ts'), 'throw new Error("server must not load");');
  return { root, out: join(root, 'compiled') };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(root: string, script: string, extraLoader = '') {
  const loader = `export async function resolve(s,c,n) {
    ${extraLoader}
    const r = await n(s,c);
    if (/\\/(tsx|esbuild)\\//.test(r.url) || /plumbus-core\\/dist\\/(cli\\/(commands\\/(?!voice\\.)|cli\\.)|governance\\/)/.test(r.url)
      || /voice\\/dist\\/runtime\\/http/.test(r.url)) throw new Error('forbidden worker import: '+r.url);
    return r;
  }`;
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { register } from 'node:module';
    register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
    ${script}
  `,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        AUTH_SECRET: '',
        PLUMBUS_ENV: 'production',
        PLUMBUS_VOICE_APP_ROOT: join(root, 'compiled'),
        PLUMBUS_VOICE_JAVASCRIPT_ONLY: 'true',
      },
    },
  );
}

describe('compiled voice applications', () => {
  it('builds without executing app code and boots a governed child without TypeScript or tooling', async () => {
    const { root, out } = await fixture();
    await buildVoiceApplication(root, out);
    // Source TypeScript must never be evaluated once the output is selected.
    await writeFile(join(out, 'app/voice/runtime.ts'), 'throw new Error("source selected");');
    const output = run(
      root,
      `
      const { bootstrapVoiceAgentRuntime } = await import(${JSON.stringify(packageUrl('dist/cli/voice-agent-bootstrap.js'))});
      const runtime = await bootstrapVoiceAgentRuntime();
      const auth = { userId: 'u', tenantId: 't', roles: ['user'], scopes: [], provider: 'livekit' };
      const deps = runtime.createDependencies(auth);
      if (runtime.voices[0]?.name !== 'probe' || deps.auth !== auth || !deps.audit || !deps.withTransaction
        || !deps.resolveCapability('interview.probe')) throw new Error('incomplete context');
      console.log('compiled-child-ok');
    `,
    );
    expect(output).toContain('compiled-child-ok');
    expect(await readFile(join(out, 'voice-build.json'), 'utf8')).toContain('"version":1');
  });

  it('starts the CLI dispatch parent without loading the app resource context', async () => {
    const { root, out } = await fixture();
    await buildVoiceApplication(root, out);
    await writeFile(
      join(out, 'app/voice/runtime.js'),
      'throw new Error("parent loaded child resources");',
    );
    const stub = join(root, 'livekit-stub.mjs');
    await writeFile(
      stub,
      `export async function startVoiceAgentWorker(opts) {
      if (opts.createDependencies || !opts.bootstrapModule || opts.voices[0]?.name !== 'probe') throw new Error('parent options');
      console.log('dispatch-parent-ok'); return { stop: async () => {} };
    }`,
    );
    const output = run(
      root,
      `
      process.argv = [process.execPath, ${JSON.stringify(join(coreRoot, 'bin/plumbus.js'))}, 'voice', 'worker', '--compiled', ${JSON.stringify(out)}];
      await import(${JSON.stringify(packageUrl('bin/plumbus.js'))});
    `,
      `if (s === '@plumbus/voice-livekit') return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
       if (s.includes('resource-context') || s.includes('voice-runtime')) throw new Error('parent imported app context');`,
    );
    expect(output).toContain('dispatch-parent-ok');
  });

  it('fails compiled startup when a voice module cannot be imported', async () => {
    const { root, out } = await fixture();
    await buildVoiceApplication(root, out);
    await writeFile(join(out, 'app/voices/broken.js'), 'throw new Error("broken compiled voice");');
    expect(() =>
      run(
        root,
        `await (await import(${JSON.stringify(packageUrl('dist/cli/voice-worker-definitions.js'))})).loadVoiceWorkerDefinitions();`,
      ),
    ).toThrow();
  });

  it('rejects non-literal dynamic imports instead of leaving a source loader dependency', async () => {
    const { root, out } = await fixture();
    await writeFile(
      join(root, 'app/voice/runtime.ts'),
      `
      export async function loadSource(name: string) { return import(name); }
      export const voiceRuntime = { resources: { capabilities: [], entities: [], events: [], prompts: [] }, extensions: {} };
    `,
    );
    await expect(buildVoiceApplication(root, out)).rejects.toThrow('statically resolvable imports');
  });

  it('refuses a nonempty output and preserves its contents', async () => {
    const { root, out } = await fixture();
    await mkdir(out);
    await writeFile(join(out, 'keep.txt'), 'keep');
    await expect(buildVoiceApplication(root, out)).rejects.toMatchObject({ code: 'validation' });
    expect(await readFile(join(out, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('requires scoped resources and fails for unresolved imports', async () => {
    const { root, out } = await fixture();
    await writeFile(join(root, 'app/voice/runtime.ts'), 'import "./missing-file.js";');
    await expect(buildVoiceApplication(root, out)).rejects.toThrow();
    await rm(join(root, 'app/voice/runtime.ts'));
    await expect(buildVoiceApplication(root, out)).rejects.toMatchObject({ code: 'validation' });
  });
});
