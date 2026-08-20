// Loads the *built* framework packages (dist) of @plumbus/core + @plumbus/chat
// without adding this smoke app to the pnpm workspace. Nothing here is installed:
// we import the already-compiled dist directly by absolute file URL. Node realpaths
// symlinks, so @plumbus/chat's own `import '@plumbus/core'` (a peer dep linked into
// packages/chat/node_modules) resolves to the SAME physical files we import here —
// one @plumbus/core instance, one zod instance, no dual-package hazard.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// lib -> chat-tool-calling-smoke -> examples -> repo root
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

const coreDir = path.join(repoRoot, 'packages/plumbus-core');
const chatDir = path.join(repoRoot, 'packages/chat');

const coreDist = path.join(coreDir, 'dist/index.js');
const coreZodDist = path.join(coreDir, 'dist/zod/index.js');
// The framework-internal seam published as `@plumbus/core/runtime`. This app
// hosts its own turn loop, so it builds an ExecutionContext itself — that is
// exactly the runtime-host role the seam exists for, and the reason the factory
// is not on the `@plumbus/core` root barrel.
const coreRuntimeDist = path.join(coreDir, 'dist/runtime-entry.js');
const chatDist = path.join(chatDir, 'dist/index.js');

for (const dist of [coreDist, coreZodDist, coreRuntimeDist, chatDist]) {
  if (!existsSync(dist)) {
    console.error(
      `[deps] Missing build output: ${dist}\n` +
        'Build the framework packages first, from the repo root:\n' +
        '  pnpm --filter @plumbus/core --filter @plumbus/chat build\n' +
        '  (or: pnpm build)',
    );
    process.exit(1);
  }
}

const fileUrl = (p) => pathToFileURL(p).href;

const core = await import(fileUrl(coreDist));
const coreZod = await import(fileUrl(coreZodDist));
const coreRuntime = await import(fileUrl(coreRuntimeDist));
const chat = await import(fileUrl(chatDist));

export const {
  createOpenAIAdapter,
  createAIService,
  singleProviderConfig,
  PromptRegistry,
  defineCapability,
} = core;
export const { createExecutionContext } = coreRuntime;
export const { z } = coreZod;
export const {
  defineChat,
  runChatTurn,
  createChatRegistry,
  chatTurnPrompt,
  chatToolRoundPrompt,
  chatScopeCheckPrompt,
} = chat;
