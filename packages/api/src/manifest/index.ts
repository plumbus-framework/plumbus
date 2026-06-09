// ── API manifest parsing, validation, and exposure resolution ──

export { parseManifest } from './parse.js';
export { resolveExposure } from './resolve.js';
export { ApiManifestSchema } from './schema.js';
export type { ApiManifest, ApiManifestEntry, ApiManifestFinding } from './types.js';
export { validateManifest } from './validate-against-registry.js';
