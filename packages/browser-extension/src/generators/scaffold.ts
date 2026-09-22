import type { BrowserExtensionScaffoldInput, GeneratedFile } from '../types.js';
import { generateAuthStore } from './auth-store.js';
import { generateBackground } from './background.js';
import { generateContent } from './content.js';
import { generateEnvExample } from './env.js';
import { generateInvoke } from './invoke.js';
import { generatePackageJson } from './package-json.js';
import { generatePopupFiles } from './popup.js';
import { generateTsConfig } from './tsconfig.js';
import { generateWxtConfig } from './wxt-config.js';

/** Emit all scaffold shell files (not including src/client/api.ts). */
export function generateBrowserExtensionScaffold(
  input: BrowserExtensionScaffoldInput,
): GeneratedFile[] {
  const { config } = input;
  return [
    generateWxtConfig(config),
    generatePackageJson(config),
    generateTsConfig(),
    generateEnvExample(config),
    generateAuthStore(config),
    generateInvoke(),
    generateBackground(config),
    generateContent(),
    ...generatePopupFiles(input),
  ];
}
