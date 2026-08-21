import { resolveAuthRoles } from '../execution/auth-roles.js';
import { AuthRole } from '../types/enums.js';
import type { AuthContext } from '../types/security.js';

const SERVICE_PROVIDERS = new Set(['worker', 'scheduler']);

/**
 * A human task is never completable by a service principal or unauthenticated
 * callback (05/01:140). Requesting approval may be machine-initiated.
 */
export function isHumanActor(auth: AuthContext): boolean {
  if (!auth.userId) {
    return false;
  }
  if (SERVICE_PROVIDERS.has(auth.provider)) {
    return false;
  }
  const roles = resolveAuthRoles(auth);
  if (roles.includes(AuthRole.System)) {
    return false;
  }
  return true;
}

export function requireHumanActor(auth: AuthContext, action: string): void {
  if (!isHumanActor(auth)) {
    throw new Error(`${action} requires an authenticated human actor`);
  }
}
