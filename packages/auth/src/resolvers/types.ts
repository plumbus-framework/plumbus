export interface VerifiedExternalIdentity {
  providerId: string;
  issuer: string;
  subject: string;
  idTokenClaims: Readonly<Record<string, unknown>>;
  userInfoClaims?: Readonly<Record<string, unknown>>;
  providerAuthenticatedAt?: Date;
  acr?: string;
  amr?: readonly string[];
}

export type IdentityResolution = { status: 'admitted'; userId: string } | { status: 'denied' };

/**
 * Trusted, application-defined context attached to a login transaction when login
 * starts, and handed back to `resolveIdentity` after the callback is validated.
 *
 * Sealed inside the login transaction: single-use, browser-bound, never sent to the
 * identity provider, never stored in the session, never emitted to audit.
 */
export interface AuthLoginApplicationContext {
  type: string;
  data?: Readonly<Record<string, unknown>>;
}

export interface IdentityResolutionContext {
  applicationContext?: AuthLoginApplicationContext;
}

export type ResolveIdentity = (
  identity: VerifiedExternalIdentity,
  context?: IdentityResolutionContext,
) => Promise<IdentityResolution>;

export interface SessionPrincipal {
  userId: string;
  providerId: string;
  issuer: string;
  subject: string;
  sessionRef: string;
  authenticatedAt: Date;
  acr?: string;
  amr?: readonly string[];
}

export type AuthorizationResolution =
  | {
      status: 'authorized';
      roles: string[];
      scopes: string[];
      tenantId?: string;
    }
  | { status: 'revoked' };

export type ResolveAuthorization = (
  principal: SessionPrincipal,
) => Promise<AuthorizationResolution>;
