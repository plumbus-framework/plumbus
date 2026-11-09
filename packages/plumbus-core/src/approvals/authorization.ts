import type { AuthorizationProvider } from './types.js';

/**
 * Lets every authenticated human decide or cancel any approval. Never
 * installed by default: `createApprovalService` refuses decisions when no
 * provider is configured, so passing this is an explicit opt-out of
 * authorization (tests, harnesses, single-operator tools).
 */
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
