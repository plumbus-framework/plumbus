import type { ContextDependencies } from '../types/context.js';
import type { ApprovalService, AuthorizationProvider } from './types.js';

/**
 * Host opt-in for the approval gate on production bootstrap.
 * Omitted fields leave existing hosts unchanged (no service, no provider).
 *
 * `authorizationProvider` is the host's gate. The harness stub
 * (`createAllowAllAuthorizationProvider`) is not installed by default —
 * the consuming application supplies the real provider.
 */
export interface HostApprovalRuntime {
  approvals?: ApprovalService;
  authorizationProvider?: AuthorizationProvider;
}

export function hostApprovalRuntimeExtras(
  config: HostApprovalRuntime | undefined,
): Partial<ContextDependencies> {
  if (!config?.approvals && !config?.authorizationProvider) {
    return {};
  }
  return {
    ...(config.approvals ? { approvals: config.approvals } : {}),
    ...(config.authorizationProvider
      ? { authorizationProvider: config.authorizationProvider }
      : {}),
  };
}
