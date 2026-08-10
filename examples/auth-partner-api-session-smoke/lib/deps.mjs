// Loads built framework packages (dist) without adding this smoke app to the
// pnpm workspace. Fastify is resolved from @plumbus/auth's node_modules so there
// is one Fastify instance for route registration + inject.
//
// Intentionally does NOT import @plumbus/core/testing (that barrel loads vitest).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// lib -> auth-partner-api-session-smoke -> examples -> repo root
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

const authPkgDir = path.join(repoRoot, 'packages/auth');
const corePkgDir = path.join(repoRoot, 'packages/plumbus-core');
const apiPkgDir = path.join(repoRoot, 'packages/api');

const authDist = path.join(authPkgDir, 'dist/index.js');
const authTestingDist = path.join(authPkgDir, 'dist/testing/index.js');
const coreDist = path.join(corePkgDir, 'dist/index.js');
const coreZodDist = path.join(corePkgDir, 'dist/zod/index.js');
const apiDist = path.join(apiPkgDir, 'dist/index.js');

for (const dist of [authDist, authTestingDist, coreDist, coreZodDist, apiDist]) {
  if (!existsSync(dist)) {
    console.error(
      `[deps] Missing build output: ${dist}\n` +
        'Build the framework packages first, from the repo root:\n' +
        '  pnpm --filter @plumbus/core --filter @plumbus/auth --filter @plumbus/api build\n' +
        '  (or: pnpm build)',
    );
    process.exit(1);
  }
}

const fileUrl = (p) => pathToFileURL(p).href;
const require = createRequire(path.join(authPkgDir, 'package.json'));

const { default: Fastify } = await import(fileUrl(require.resolve('fastify')));
const auth = await import(fileUrl(authDist));
const authTesting = await import(fileUrl(authTestingDist));
const core = await import(fileUrl(coreDist));
const coreZod = await import(fileUrl(coreZodDist));
const api = await import(fileUrl(apiDist));

export { Fastify };
export const {
  createAuthRuntime,
  createMemorySessionStore,
  createMemoryLoginTransactionStore,
} = auth;
export const { startFakeOidcProvider } = authTesting;
export const { defineCapability } = core;
export const { z } = coreZod;
export const { registerApiRoutes } = api;

export function createTestAuth(options = {}) {
  return {
    userId: options.userId ?? 'test-user',
    roles: options.roles ?? [],
    scopes: options.scopes ?? [],
    tenantId: options.tenantId,
    provider: options.provider ?? 'test',
  };
}

export function mockEvents() {
  return { emit: async () => {}, subscribe: () => () => {} };
}

export function mockFlows() {
  return { start: async () => ({ id: 'flow-1' }), get: async () => null };
}

export function mockAI() {
  return {
    generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }),
  };
}

export function mockAudit() {
  return { record: async () => {} };
}

export function mockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => mockLogger(),
  };
}
