import type { BrowserExtensionScaffoldConfig, GeneratedFile } from '../types.js';

export function generateEnvExample(config: BrowserExtensionScaffoldConfig): GeneratedFile {
  const base = config.apiBaseUrl.replace(/\/$/, '');
  return {
    path: '.env.example',
    content: `# Reference only — the scaffold bakes API_BASE_URL into generated files at scaffold time.
# Re-run \`plumbus browser-extension scaffold\` after changing the API host.
#
# If you later wire env-based config in WXT, use a VITE_/WXT_ prefixed variable, e.g.:
# WXT_PLUMBUS_API_BASE_URL=${base}
`,
  };
}
