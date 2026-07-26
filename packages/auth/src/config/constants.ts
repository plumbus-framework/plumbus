export const SESSION_TTL_MAX_MS = 31_536_000_000;
export const TX_TTL_DEFAULT_MS = 600_000;
export const TX_TTL_MAX_MS = 21_600_000;
export const TX_PER_BROWSER_DEFAULT = 5;
export const TX_PER_BROWSER_MAX = 20;
export const MAX_SESSIONS_PER_USER_DEFAULT = 5;
export const MAX_SESSIONS_PER_USER_MAX = 100;
export const RESOLVER_TIMEOUT_DEFAULT_MS = 5_000;
export const RESOLVER_TIMEOUT_MAX_MS = 30_000;
export const PROVIDER_FETCH_TIMEOUT_DEFAULT_MS = 10_000;
export const PROVIDER_FETCH_TIMEOUT_MAX_MS = 30_000;
export const PROVIDER_RESPONSE_MAX_BYTES = 1_048_576;
export const PROVIDER_MAX_REDIRECTS = 3;
export const MAX_ROLES_DEFAULT = 256;
export const MAX_SCOPES_DEFAULT = 1024;
export const ROLES_SCOPES_CEILING = 4096;
export const IDENTIFIER_MAX_BYTES = 256;
export const USER_ID_MAX_BYTES = 512;
export const ID_GRAMMAR = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const LOGIN_CONTEXT_TYPE_MAX_BYTES = 128;
export const LOGIN_CONTEXT_MAX_BYTES_DEFAULT = 1_024;
export const LOGIN_CONTEXT_MAX_BYTES_CEILING = 4_096;
export const LOGIN_CONTEXT_PARAMS_MAX = 8;

export const RESERVED_AUTH_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'response_mode',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
] as const;
