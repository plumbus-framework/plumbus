// Loads built framework packages (dist) without adding this smoke to the workspace.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// lib -> ai-bedrock-smoke -> examples -> repo root
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

const coreDir = path.join(repoRoot, 'packages/plumbus-core');
const bedrockDir = path.join(repoRoot, 'packages/ai-bedrock');

const coreDist = path.join(coreDir, 'dist/index.js');
const bedrockDist = path.join(bedrockDir, 'dist/index.js');

for (const dist of [coreDist, bedrockDist]) {
  if (!existsSync(dist)) {
    console.error(
      `[deps] Missing build output: ${dist}\n` +
        'Build the framework packages first, from the repo root:\n' +
        '  pnpm --filter @plumbus/core --filter @plumbus/ai-bedrock build\n' +
        '  (or: pnpm build)',
    );
    process.exit(1);
  }
}

const fileUrl = (p) => pathToFileURL(p).href;

const core = await import(fileUrl(coreDist));
const bedrock = await import(fileUrl(bedrockDist));

export const { createOpenAIAdapter } = core;
export const { createBedrockAdapter, BEDROCK_DEFAULT_EMBEDDING_MODEL } = bedrock;
