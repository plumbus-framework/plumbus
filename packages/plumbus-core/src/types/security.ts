// ── Access Policy ──
export interface AccessPolicy {
  roles?: string[];
  scopes?: string[];
  public?: boolean;
  tenantScoped?: boolean;
  serviceAccounts?: string[];
}

// ── Auth Context ──
export interface AuthContext {
  userId?: string;
  roles: string[];
  scopes: string[];
  tenantId?: string;
  provider: string;
  sessionId?: string;
  authenticatedAt?: Date;
  /** When true, skip role/scope checks (e.g. flow-driven execution). Tenant scoping still enforced. */
  internal?: boolean;
}
