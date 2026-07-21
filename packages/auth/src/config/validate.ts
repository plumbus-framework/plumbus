import { parseDurationToMs } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import type { OidcProviderIntegration } from '../providers/integration.js';
import {
  ID_GRAMMAR,
  MAX_ROLES_DEFAULT,
  MAX_SCOPES_DEFAULT,
  MAX_SESSIONS_PER_USER_DEFAULT,
  MAX_SESSIONS_PER_USER_MAX,
  PROVIDER_FETCH_TIMEOUT_DEFAULT_MS,
  PROVIDER_FETCH_TIMEOUT_MAX_MS,
  RESOLVER_TIMEOUT_DEFAULT_MS,
  RESOLVER_TIMEOUT_MAX_MS,
  ROLES_SCOPES_CEILING,
  SESSION_TTL_MAX_MS,
  TX_PER_BROWSER_DEFAULT,
  TX_PER_BROWSER_MAX,
  TX_TTL_MAX_MS,
} from './constants.js';
import { secretSourceSchema } from '../crypto/secret-source.js';
import type {
  AuthRuntimeConfig,
  NormalizedAuthRuntimeConfig,
  NormalizedOidcProviderRegistration,
} from './types.js';

const storageProtectionSchema = z
  .object({
    activeKey: z.object({ id: z.string(), value: secretSourceSchema }).strict(),
    decryptOnlyKeys: z
      .array(z.object({ id: z.string(), value: secretSourceSchema }).strict())
      .optional(),
  })
  .strict();

const providerRegistrationSchema = z
  .object({
    type: z.literal('oidc'),
    issuer: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: secretSourceSchema,
    scopes: z.array(z.string()),
    integration: z.custom<OidcProviderIntegration>().optional(),
    fetchUserInfo: z.boolean().optional(),
    discoverable: z.boolean().optional(),
    display: z
      .object({ label: z.string().min(1) })
      .strict()
      .optional(),
    providerLogout: z.object({ returnTo: z.string() }).strict().optional(),
  })
  .strict();

const authRuntimeConfigSchema = z
  .object({
    applicationId: z.string().regex(ID_GRAMMAR),
    externalBaseUrl: z.string().url(),
    applicationBaseUrl: z.string().url(),
    basePath: z.string().optional(),
    defaultReturnPath: z.string(),
    errorPath: z.string(),
    environment: z.enum(['development', 'production']),
    session: z
      .object({
        ttl: z.string(),
        cookieName: z.string().optional(),
        maxSessionsPerUser: z.number().int().optional(),
        sameSite: z.enum(['Lax', 'Strict']).optional(),
      })
      .strict(),
    transactions: z
      .object({
        ttl: z.string().optional(),
        maxOutstandingPerBrowser: z.number().int().optional(),
      })
      .strict()
      .optional(),
    providers: z.record(z.string(), providerRegistrationSchema),
    defaultProvider: z.string().optional(),
    sessionStore: z.custom(),
    transactionStore: z.custom(),
    storageProtection: storageProtectionSchema,
    resolveIdentity: z.function(),
    resolveAuthorization: z.function(),
    auditWriter: z.custom().optional(),
    timeouts: z
      .object({
        resolver: z.string().optional(),
        providerFetch: z.string().optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxRoles: z.number().int().optional(),
        maxScopes: z.number().int().optional(),
      })
      .strict()
      .optional(),
    deployment: z
      .object({
        assumeSameSite: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function parseCanonicalUrl(raw: string, label: string, requireHttps: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not include query or fragment`);
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS in production`);
  }
  return url;
}

function validateLocalPath(path: string, label: string): void {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`${label} must be a local path starting with exactly one /`);
  }
  if (path.includes('\\') || path.includes('://')) {
    throw new Error(`${label} must not include scheme or backslashes`);
  }
  try {
    if (decodeURIComponent(path).startsWith('//')) {
      throw new Error(`${label} must not be protocol-relative after decode`);
    }
  } catch {
    throw new Error(`${label} must be a valid path`);
  }
}

function validateBasePath(basePath: string): string {
  if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#')) {
    throw new Error('basePath must be an absolute local path without query or fragment');
  }
  if (basePath.includes('*') || basePath.includes(':')) {
    throw new Error('basePath must not contain wildcards or parameters');
  }
  return basePath.endsWith('/') && basePath.length > 1 ? basePath.slice(0, -1) : basePath;
}

function normalizeProvider(
  id: string,
  reg: z.infer<typeof providerRegistrationSchema>,
): NormalizedOidcProviderRegistration {
  if (!ID_GRAMMAR.test(id)) {
    throw new Error(`Provider id "${id}" does not match required grammar`);
  }
  const scopes = [...reg.scopes];
  if (!scopes.includes('openid')) {
    scopes.unshift('openid');
  }
  if (scopes.includes('offline_access')) {
    throw new Error(`Provider "${id}" scopes must not include offline_access`);
  }
  const discoverable = reg.discoverable ?? false;
  if (discoverable && !reg.display?.label) {
    throw new Error(`Discoverable provider "${id}" requires display.label`);
  }
  if (reg.providerLogout?.returnTo) {
    validateLocalPath(reg.providerLogout.returnTo, `providers.${id}.providerLogout.returnTo`);
  }
  const warnings = reg.integration?.validateRegistration?.({
    issuer: reg.issuer,
    scopes,
    fetchUserInfo: reg.fetchUserInfo,
    providerLogout: reg.providerLogout,
  });
  if (warnings && warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`[@plumbus/auth] provider "${id}": ${warning}`);
    }
  }
  return {
    type: 'oidc',
    issuer: reg.issuer,
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    scopes,
    integration: reg.integration,
    fetchUserInfo: reg.fetchUserInfo ?? false,
    discoverable,
    display: reg.display,
    providerLogout: reg.providerLogout,
  };
}

export function validateAuthRuntimeConfig(config: AuthRuntimeConfig): NormalizedAuthRuntimeConfig {
  const parsed = authRuntimeConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message ?? 'Invalid auth runtime configuration');
  }

  const requireHttps = config.environment === 'production';
  const externalBaseUrl = parseCanonicalUrl(
    config.externalBaseUrl,
    'externalBaseUrl',
    requireHttps,
  );
  const applicationBaseUrl = parseCanonicalUrl(
    config.applicationBaseUrl,
    'applicationBaseUrl',
    requireHttps,
  );
  const basePath = validateBasePath(config.basePath ?? '/auth');
  validateLocalPath(config.defaultReturnPath, 'defaultReturnPath');
  validateLocalPath(config.errorPath, 'errorPath');

  const sessionTtlMs = parseDurationToMs(config.session.ttl, { label: 'session.ttl' });
  if (sessionTtlMs <= 0) {
    throw new Error('session.ttl must be positive');
  }
  if (sessionTtlMs > SESSION_TTL_MAX_MS) {
    throw new Error('session.ttl exceeds maximum of 365 days');
  }

  const maxSessionsPerUser = config.session.maxSessionsPerUser ?? MAX_SESSIONS_PER_USER_DEFAULT;
  if (maxSessionsPerUser < 1 || maxSessionsPerUser > MAX_SESSIONS_PER_USER_MAX) {
    throw new Error(
      `session.maxSessionsPerUser must be between 1 and ${MAX_SESSIONS_PER_USER_MAX}`,
    );
  }

  let cookieName = config.session.cookieName ?? '__Host-plumbus_session';
  if (requireHttps && !cookieName.startsWith('__Host-')) {
    throw new Error('session.cookieName must use __Host- prefix in production');
  }
  if (!requireHttps) {
    cookieName = config.session.cookieName ?? 'plumbus_session';
  }

  const sameSite = config.session.sameSite ?? 'Lax';

  const txTtlMs = parseDurationToMs(config.transactions?.ttl ?? '10m', {
    label: 'transactions.ttl',
  });
  if (txTtlMs <= 0 || txTtlMs > TX_TTL_MAX_MS) {
    throw new Error('transactions.ttl must be positive and at most 6 hours');
  }
  const maxOutstandingPerBrowser =
    config.transactions?.maxOutstandingPerBrowser ?? TX_PER_BROWSER_DEFAULT;
  if (maxOutstandingPerBrowser < 1 || maxOutstandingPerBrowser > TX_PER_BROWSER_MAX) {
    throw new Error(
      `transactions.maxOutstandingPerBrowser must be between 1 and ${TX_PER_BROWSER_MAX}`,
    );
  }

  const providerIds = Object.keys(config.providers);
  if (providerIds.length === 0) {
    throw new Error('At least one provider must be configured');
  }
  const normalizedProviders: Record<string, NormalizedOidcProviderRegistration> = {};
  for (const id of providerIds) {
    normalizedProviders[id] = normalizeProvider(
      id,
      config.providers[id] as z.infer<typeof providerRegistrationSchema>,
    );
  }
  if (config.defaultProvider && !normalizedProviders[config.defaultProvider]) {
    throw new Error(`defaultProvider "${config.defaultProvider}" is not registered`);
  }

  const resolverTimeoutMs = config.timeouts?.resolver
    ? parseDurationToMs(config.timeouts.resolver, { label: 'timeouts.resolver' })
    : RESOLVER_TIMEOUT_DEFAULT_MS;
  if (resolverTimeoutMs <= 0 || resolverTimeoutMs > RESOLVER_TIMEOUT_MAX_MS) {
    throw new Error('timeouts.resolver must be positive and at most 30s');
  }

  const providerFetchTimeoutMs = config.timeouts?.providerFetch
    ? parseDurationToMs(config.timeouts.providerFetch, { label: 'timeouts.providerFetch' })
    : PROVIDER_FETCH_TIMEOUT_DEFAULT_MS;
  if (providerFetchTimeoutMs <= 0 || providerFetchTimeoutMs > PROVIDER_FETCH_TIMEOUT_MAX_MS) {
    throw new Error('timeouts.providerFetch must be positive and at most 30s');
  }

  const maxRoles = config.limits?.maxRoles ?? MAX_ROLES_DEFAULT;
  const maxScopes = config.limits?.maxScopes ?? MAX_SCOPES_DEFAULT;
  if (maxRoles < 1 || maxRoles > ROLES_SCOPES_CEILING) {
    throw new Error(`limits.maxRoles must be between 1 and ${ROLES_SCOPES_CEILING}`);
  }
  if (maxScopes < 1 || maxScopes > ROLES_SCOPES_CEILING) {
    throw new Error(`limits.maxScopes must be between 1 and ${ROLES_SCOPES_CEILING}`);
  }

  const normalized: NormalizedAuthRuntimeConfig = {
    applicationId: config.applicationId,
    externalBaseUrl,
    applicationBaseUrl,
    basePath,
    defaultReturnPath: config.defaultReturnPath,
    errorPath: config.errorPath,
    environment: config.environment,
    session: {
      ttlMs: sessionTtlMs,
      cookieName,
      maxSessionsPerUser,
      sameSite,
    },
    transactions: {
      ttlMs: txTtlMs,
      maxOutstandingPerBrowser,
    },
    providers: normalizedProviders,
    defaultProvider: config.defaultProvider,
    sessionStore: config.sessionStore,
    transactionStore: config.transactionStore,
    storageProtection: config.storageProtection,
    resolveIdentity: config.resolveIdentity,
    resolveAuthorization: config.resolveAuthorization,
    auditWriter: config.auditWriter,
    resolverTimeoutMs,
    providerFetchTimeoutMs,
    maxRoles,
    maxScopes,
    deployment: {
      assumeSameSite: config.deployment?.assumeSameSite ?? false,
    },
  };

  return Object.freeze(normalized);
}
