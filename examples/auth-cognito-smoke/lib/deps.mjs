// Loads the *built* framework packages (dist) plus fastify, without adding this
// smoke app to the pnpm workspace. Nothing here is installed — we import the
// already-compiled output of @plumbus/auth + @plumbus/auth-cognito and resolve
// fastify from the auth package's own node_modules (so there is exactly one
// fastify instance, the same copy @plumbus/auth registers routes against).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// lib -> auth-cognito-smoke -> examples -> repo root
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

const authPkgDir = path.join(repoRoot, 'packages/auth');
const authDist = path.join(authPkgDir, 'dist/index.js');
const cognitoDist = path.join(repoRoot, 'packages/auth-cognito/dist/index.js');

for (const dist of [authDist, cognitoDist]) {
  if (!existsSync(dist)) {
    console.error(
      `[deps] Missing build output: ${dist}\n` +
        'Build the framework packages first, from the repo root:\n' +
        '  turbo run build --filter=@plumbus/auth-cognito',
    );
    process.exit(1);
  }
}

const fileUrl = (p) => pathToFileURL(p).href;
const require = createRequire(path.join(authPkgDir, 'package.json'));

const { default: Fastify } = await import(fileUrl(require.resolve('fastify')));
const auth = await import(fileUrl(authDist));
const cognitoPkg = await import(fileUrl(cognitoDist));

export { Fastify };
export const {
  createAuthRuntime,
  createMemorySessionStore,
  createMemoryLoginTransactionStore,
} = auth;
export const { cognito } = cognitoPkg;
