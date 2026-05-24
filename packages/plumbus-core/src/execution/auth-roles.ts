import { AuthRole } from '../types/enums.js';
import type { AuthContext } from '../types/security.js';

/**
 * Resolve roles used for access checks. Maps deprecated `internal` to `system` for compatibility.
 */
export function resolveAuthRoles(auth: AuthContext): string[] {
  const roles = [...auth.roles];
  if (auth.internal === true && !roles.includes(AuthRole.System)) {
    roles.push(AuthRole.System);
  }
  return roles;
}
