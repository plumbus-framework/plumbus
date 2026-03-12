import type { AccessPolicy, AuthContext } from '../types/security.js';

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Evaluate an AccessPolicy against an AuthContext.
 * Deny-by-default: if no policy is provided, access is denied.
 */
export function evaluateAccess(
  policy: AccessPolicy | undefined,
  auth: AuthContext,
): AuthorizationResult {
  // No policy → deny by default
  if (!policy) {
    return { allowed: false, reason: 'No access policy defined' };
  }

  // Public capabilities are always allowed
  if (policy.public) {
    return { allowed: true };
  }

  // Must be authenticated (have a userId)
  if (!auth.userId) {
    return { allowed: false, reason: 'Authentication required' };
  }

  // Service account check — if the caller is a recognized service account, allow
  if (policy.serviceAccounts && policy.serviceAccounts.length > 0) {
    if (auth.userId && policy.serviceAccounts.includes(auth.userId)) {
      return { allowed: true };
    }
  }

  // Tenant scope enforcement
  if (policy.tenantScoped && !auth.tenantId) {
    return { allowed: false, reason: 'Tenant context required' };
  }

  // Role check — caller must have at least one required role
  if (policy.roles && policy.roles.length > 0) {
    const hasRole = policy.roles.some((r) => auth.roles.includes(r));
    if (!hasRole) {
      return {
        allowed: false,
        reason: `Required roles: ${policy.roles.join(', ')}`,
      };
    }
  }

  // Scope check — caller must have all required scopes
  if (policy.scopes && policy.scopes.length > 0) {
    const missingScopes = policy.scopes.filter((s) => !auth.scopes.includes(s));
    if (missingScopes.length > 0) {
      return {
        allowed: false,
        reason: `Missing scopes: ${missingScopes.join(', ')}`,
      };
    }
  }

  return { allowed: true };
}
