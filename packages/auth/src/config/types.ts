import type { AuditWriter } from '@plumbus/core';
import type { SecretSource, StorageProtectionConfig } from '../crypto/protection.js';
import type { OidcProviderIntegration } from '../providers/integration.js';
import type { ResolveAuthorization, ResolveIdentity } from '../resolvers/types.js';
import type { LoginTransactionStore, SessionStore } from '../stores/types.js';

export type Duration = string;

export const CookieSameSite = {
  Lax: 'Lax',
  Strict: 'Strict',
} as const;

export type CookieSameSite = (typeof CookieSameSite)[keyof typeof CookieSameSite];

export interface AuthRuntimeConfig {
  applicationId: string;
  externalBaseUrl: string;
  applicationBaseUrl: string;
  basePath?: string;
  defaultReturnPath: string;
  errorPath: string;
  environment: 'development' | 'production';

  session: {
    ttl: Duration;
    cookieName?: string;
    maxSessionsPerUser?: number;
    sameSite?: CookieSameSite;
  };

  transactions?: {
    ttl?: Duration;
    maxOutstandingPerBrowser?: number;
  };

  providers: Record<string, OidcProviderRegistration>;
  defaultProvider?: string;

  sessionStore: SessionStore;
  transactionStore: LoginTransactionStore;
  storageProtection: StorageProtectionConfig;

  resolveIdentity: ResolveIdentity;
  resolveAuthorization: ResolveAuthorization;

  auditWriter?: AuditWriter;
  timeouts?: {
    resolver?: Duration;
    providerFetch?: Duration;
  };
  limits?: {
    maxRoles?: number;
    maxScopes?: number;
  };
  deployment?: {
    assumeSameSite?: boolean;
  };
}

export interface OidcProviderRegistration {
  type: 'oidc';
  issuer: string;
  clientId: string;
  clientSecret: SecretSource;
  scopes: string[];
  integration?: OidcProviderIntegration;
  fetchUserInfo?: boolean;
  discoverable?: boolean;
  display?: { label: string };
  providerLogout?: { returnTo: string };
}

export interface NormalizedAuthRuntimeConfig {
  applicationId: string;
  externalBaseUrl: URL;
  applicationBaseUrl: URL;
  basePath: string;
  defaultReturnPath: string;
  errorPath: string;
  environment: 'development' | 'production';

  session: {
    ttlMs: number;
    cookieName: string;
    maxSessionsPerUser: number;
    sameSite: CookieSameSite;
  };

  transactions: {
    ttlMs: number;
    maxOutstandingPerBrowser: number;
  };

  providers: Record<string, NormalizedOidcProviderRegistration>;
  defaultProvider?: string;

  sessionStore: SessionStore;
  transactionStore: LoginTransactionStore;
  storageProtection: StorageProtectionConfig;

  resolveIdentity: ResolveIdentity;
  resolveAuthorization: ResolveAuthorization;

  auditWriter?: AuditWriter;
  resolverTimeoutMs: number;
  providerFetchTimeoutMs: number;
  maxRoles: number;
  maxScopes: number;
  deployment: {
    assumeSameSite: boolean;
  };
}

export interface NormalizedOidcProviderRegistration {
  type: 'oidc';
  issuer: string;
  clientId: string;
  clientSecret: SecretSource;
  scopes: string[];
  integration?: OidcProviderIntegration;
  fetchUserInfo: boolean;
  discoverable: boolean;
  display?: { label: string };
  providerLogout?: { returnTo: string };
}

export type { SecretSource, StorageProtectionConfig };
