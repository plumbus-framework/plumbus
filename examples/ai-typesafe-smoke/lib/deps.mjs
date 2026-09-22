// Loads built framework packages (dist) without adding this smoke to the workspace.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// lib -> ai-typesafe-smoke -> examples -> repo root
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

const coreDist = path.join(repoRoot, 'packages/plumbus-core/dist/index.js');
const typesafeDist = path.join(repoRoot, 'packages/ai-typesafe/dist/index.js');

for (const dist of [coreDist, typesafeDist]) {
  if (!existsSync(dist)) {
    console.error(
      `[deps] Missing build output: ${dist}\n` +
        'Build the framework packages first, from the repo root:\n' +
        '  pnpm --filter @plumbus/core --filter @plumbus/ai-typesafe build\n' +
        '  (or: pnpm build)',
    );
    process.exit(1);
  }
}

const fileUrl = (p) => pathToFileURL(p).href;

const core = await import(fileUrl(coreDist));
const typesafe = await import(fileUrl(typesafeDist));

export const { createAIService, createCostTracker, choice, noul, score } = core;
export const { createTypeSafeAdapter, createTypeSafeDecisionAdapter, JEV_CAPABILITIES } = typesafe;
