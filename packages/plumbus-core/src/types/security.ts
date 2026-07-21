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
  /** Configured provider registration id (e.g. 'cognito') when provider is a multi-provider mechanism */
  providerId?: string;
  sessionId?: string;
  authenticatedAt?: Date;
  /**
   * @deprecated Use role {@link AuthRole.System} (`system`) instead. Still mapped to `system` for compatibility.
   */
  internal?: boolean;
}
