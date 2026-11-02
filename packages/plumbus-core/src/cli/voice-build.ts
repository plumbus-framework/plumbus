import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createErrorService } from '../errors/index.js';
import { assertNoSymlinkPath } from './scaffold-validation.js';

/** Build app-owned voice entrypoints without importing or executing app code. */
export async function buildVoiceApplication(
  appRoot: string,
  outputDirectory: string,
): Promise<void> {
  const root = path.resolve(appRoot);
  const out = path.resolve(outputDirectory);
  assertNoSymlinkPath(out);
  if (existsSync(out) && (await fs.readdir(out)).length > 0) {
    throw createErrorService().validation(
      'Voice build output must be empty; choose a fresh output directory',
    );
  }
  const choose = (base: string) =>
    ['.ts', '.js', '.mjs']
      .map((extension) => path.join(root, base + extension))
      .find((candidate) => existsSync(candidate));
  const runtime = choose('app/voice/runtime');
  const registry = choose('app/voice/registry');
  if (!runtime || !registry) {
    throw createErrorService().validation(
      'Voice build requires app/voice/runtime and app/voice/registry',
    );
  }
  const voicesDir = path.join(root, 'app/voices');
  const voices = (await fs.readdir(voicesDir, { recursive: true }))
    .filter(
      (file) =>
        /\.(ts|js|mjs)$/.test(file) &&
        !/\.d\.ts$|\.(test|spec)\.|(^|[/\\])__tests__([/\\]|$)/.test(file),
    )
    .map((file) => path.join(voicesDir, file));
  if (!voices.length)
    throw createErrorService().validation('Voice build requires app/voices modules');
  const config = choose('config/app.config');
  const { build } = await import('esbuild');
  // A failed build writes no partial output. Dependencies remain external so
  // native modules and framework registries retain their normal module identity.
  const result = await build({
    absWorkingDir: root,
    entryPoints: [runtime, registry, ...voices, ...(config ? [config] : [])],
    outdir: out,
    outbase: root,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    write: false,
    logOverride: { 'unsupported-dynamic-import': 'warning', 'unsupported-require-call': 'warning' },
    plugins: [
      {
        name: 'voice-runtime-imports',
        setup(builder) {
          builder.onResolve({ filter: /^@plumbus\/(core|voice)$/ }, (args) => ({
            path: args.path === '@plumbus/core' ? '@plumbus/core/sdk' : '@plumbus/voice/session',
            external: true,
          }));
        },
      },
    ],
  });
  // Non-literal imports cannot be precompiled reliably. Keep the build explicit
  // rather than silently shipping a runtime dependency on source TypeScript.
  if (
    result.warnings.some((warning) =>
      ['unsupported-dynamic-import', 'unsupported-require-call'].includes(warning.id),
    )
  ) {
    throw createErrorService().validation('Voice build requires statically resolvable imports');
  }
  for (const file of result.outputFiles) {
    assertNoSymlinkPath(file.path);
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.contents, { flag: 'wx' });
  }
  await fs.writeFile(path.join(out, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
  await fs.writeFile(path.join(out, 'voice-build.json'), JSON.stringify({ version: 1 }), {
    flag: 'wx',
  });
}
