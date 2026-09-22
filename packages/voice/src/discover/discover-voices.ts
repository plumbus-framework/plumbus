import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VoiceDefinition } from '../types/voice.js';

export interface DiscoverVoicesOptions {
  appRoot?: string;
}

function isVoiceDefinition(value: unknown): value is VoiceDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as VoiceDefinition).kind === 'voice' &&
    typeof (value as VoiceDefinition).name === 'string'
  );
}

async function scanVoicesDir(dir: string): Promise<VoiceDefinition[]> {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter(
      (file) =>
        (file.endsWith('.ts') || file.endsWith('.js')) &&
        !file.endsWith('.d.ts') &&
        !file.endsWith('.test.ts') &&
        !file.endsWith('.test.js'),
    );

  const voices: VoiceDefinition[] = [];
  let unregister: (() => void) | undefined;

  try {
    const require = createRequire(import.meta.url);
    const tsxPath = require.resolve('tsx/esm/api');
    const tsx = await import(pathToFileURL(tsxPath).href);
    unregister = tsx.register();
  } catch {
    // tsx unavailable — only .js voice modules can be imported
  }

  try {
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
        for (const value of Object.values(mod)) {
          if (isVoiceDefinition(value)) {
            voices.push(value);
          }
        }
      } catch {
        // skip modules that fail to import
      }
    }
  } finally {
    unregister?.();
  }

  return voices;
}

export async function discoverVoices(
  options: DiscoverVoicesOptions = {},
): Promise<VoiceDefinition[]> {
  const appRoot = options.appRoot ?? process.cwd();
  const voicesDir = path.join(appRoot, 'app', 'voices');
  const discovered = await scanVoicesDir(voicesDir);
  const byName = new Map(discovered.map((voice) => [voice.name, voice]));
  return [...byName.values()];
}
