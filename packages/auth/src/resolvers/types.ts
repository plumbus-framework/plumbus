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

export type ResolveIdentity = (identity: VerifiedExternalIdentity) => Promise<IdentityResolution>;

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
