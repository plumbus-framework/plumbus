import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerExtensions } from './bootstrap.js';

/** Load optional hooks from app/server.ts or app/server.js. */
export async function loadServerExtensions(cwd = process.cwd()): Promise<ServerExtensions> {
  let unregisterTsx: (() => void) | undefined;
  try {
    const req = createRequire(import.meta.url);
    const tsxPath = req.resolve('tsx/esm/api');
    const tsx = await import(pathToFileURL(tsxPath).href);
    unregisterTsx = tsx.register();
  } catch {
    // tsx not available
  }

  const extensions: ServerExtensions = {};
  for (const ext of ['app/server.ts', 'app/server.js']) {
    const extPath = path.resolve(cwd, ext);
    if (!fs.existsSync(extPath)) continue;
    try {
      const mod = await import(pathToFileURL(extPath).href);
      extensions.onRoutesRegistered = mod.onRoutesRegistered ?? mod.default?.onRoutesRegistered;
      extensions.resolveAiOverrides = mod.resolveAiOverrides ?? mod.default?.resolveAiOverrides;
      extensions.onCapabilityError = mod.onCapabilityError ?? mod.default?.onCapabilityError;
      extensions.onProcessError = mod.onProcessError ?? mod.default?.onProcessError;
      extensions.onAICostRecorded = mod.onAICostRecorded ?? mod.default?.onAICostRecorded;
      extensions.enableStrictStructuredOutputs =
        mod.enableStrictStructuredOutputs ?? mod.default?.enableStrictStructuredOutputs;
      extensions.onFlowError = mod.onFlowError ?? mod.default?.onFlowError;
    } catch {
      // caller may log
    }
    break;
  }

  unregisterTsx?.();
  return extensions;
}
