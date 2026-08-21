import type { AuthorizationProvider } from './types.js';

/** Harness stub. The host application supplies the real gate. */
export function createAllowAllAuthorizationProvider(): AuthorizationProvider {
  return {
    async revalidate() {
      return { allowed: true };
    },
  };
}

export function createDenyAuthorizationProvider(
  reason = 'authorization revalidation denied',
): AuthorizationProvider {
  return {
    async revalidate() {
      return { allowed: false, reason };
    },
  };
}
