// ── Auth Module ──
// Authentication adapters for extracting identity from requests.
// Currently supports JWT with configurable claim mapping.
//
// Key exports: createJwtAdapter, AuthAdapter

export { createJwtAdapter } from './adapter.js';
export type { AuthAdapter, JwtAdapterConfig, JwtClaimMapping } from './adapter.js';
