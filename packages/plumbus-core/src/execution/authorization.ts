import { PlumbusError, UnauthorizedError } from '../errors/index.js';
import { ErrorCode } from '../types/enums.js';
import { resolveAuthRoles } from './auth-roles.js';
import type { AccessPolicy, AuthContext } from '../types/security.js';

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
  /** Set when the caller presented no identity at all: a 401, not a 403. */
  unauthenticated?: boolean;
}

/**
 * The error for a refused {@link AuthorizationResult}: `unauthorized` (401) when the caller
 * is not authenticated, so a client knows to sign in; `forbidden` (403) otherwise.
 */
export function accessDenialError(
  result: AuthorizationResult,
  metadata: Record<string, unknown>,
): PlumbusError {
  if (result.unauthenticated) {
    return new UnauthorizedError(result.reason ?? 'Authentication required', metadata);
  }
  return new PlumbusError(ErrorCode.Forbidden, result.reason ?? 'Access denied', metadata);
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
    return { allowed: false, reason: 'Authentication required', unauthenticated: true };
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

  const roles = resolveAuthRoles(auth);

  // Role check — caller must have at least one required role
  if (policy.roles && policy.roles.length > 0) {
    const hasRole = policy.roles.some((r) => roles.includes(r));
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
