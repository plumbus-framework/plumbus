import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VoiceProvidersConfig } from '../types/provider.js';
import type { VoiceProviderRegistry } from '../providers/registry.js';

export interface AppVoiceRegistryModule {
  registry: VoiceProviderRegistry;
  providers?: VoiceProvidersConfig;
}

export interface LoadAppVoiceRegistryOptions {
  appRoot?: string;
}

function looksLikeRegistry(value: unknown): value is VoiceProviderRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stt' in value &&
    'tts' in value &&
    'transport' in value
  );
}

/**
 * Loads `app/voice/registry.ts` (or `.js`) from the app root.
 * The module must export `voiceProviderRegistry` (or `registry`).
 * Optional `voiceProviders` / `providers` supply credentials for the CLI/worker.
 */
export async function loadAppVoiceRegistry(
  options: LoadAppVoiceRegistryOptions = {},
): Promise<AppVoiceRegistryModule | null> {
  const appRoot = options.appRoot ?? process.cwd();
  const candidates = [
    path.join(appRoot, 'app', 'voice', 'registry.ts'),
    path.join(appRoot, 'app', 'voice', 'registry.js'),
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    return null;
  }

  let unregister: (() => void) | undefined;
  try {
    if (filePath.endsWith('.ts')) {
      const require = createRequire(import.meta.url);
      const tsxPath = require.resolve('tsx/esm/api');
      const tsx = await import(pathToFileURL(tsxPath).href);
      unregister = tsx.register();
    }
    const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
    const registry = mod.voiceProviderRegistry ?? mod.registry;
    if (!looksLikeRegistry(registry)) {
      throw new Error(
        `${filePath} must export voiceProviderRegistry (a createProviderRegistry() result)`,
      );
    }
    const providersRaw = mod.voiceProviders ?? mod.providers;
    const providers =
      typeof providersRaw === 'object' &&
      providersRaw !== null &&
      'providers' in providersRaw &&
      typeof (providersRaw as VoiceProvidersConfig).providers === 'object'
        ? (providersRaw as VoiceProvidersConfig)
        : undefined;
    return { registry, providers };
  } finally {
    unregister?.();
  }
}
