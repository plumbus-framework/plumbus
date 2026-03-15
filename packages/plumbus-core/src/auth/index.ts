// ── Auth Module ──
// Authentication adapters for extracting identity from requests.
// JWT adapter, OIDC adapter, SAML adapter, SCIM provisioning, password hashing.

export { createJwtAdapter, signJwt } from './adapter.js';
export type { AuthAdapter, JwtAdapterConfig, JwtClaimMapping, SignJwtOptions } from './adapter.js';
export { createOidcAdapter } from './oidc-adapter.js';
export type { OidcAdapterConfig, JsonWebKey as OidcJwk } from './oidc-adapter.js';
export { hashPassword, verifyPassword } from './password.js';
export type { PasswordHashOptions } from './password.js';
export { createSamlAdapter } from './saml-adapter.js';
export type { SamlAdapterConfig } from './saml-adapter.js';
export { createScimService } from './scim.js';
export type {
  ScimEmail,
  ScimError,
  ScimListResponse,
  ScimService,
  ScimServiceConfig,
  ScimUser,
  ScimUserRepository,
  ScimUserResource,
} from './scim.js';
