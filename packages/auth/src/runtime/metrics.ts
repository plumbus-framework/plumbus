export interface AuthMetrics {
  onLoginStart?(providerId: string): void;
  onLoginOutcome?(
    providerId: string,
    outcome: 'success' | 'failure' | 'denied' | 'cancelled',
  ): void;
  onCallbackFailure?(providerId: string, category: string): void;
  onDiscoveryProbe?(providerId: string, available: boolean, durationMs: number): void;
  onResolverLatency?(kind: 'identity' | 'authorization', durationMs: number): void;
  onSessionEvent?(event: string): void;
  onAuditFailure?(): void;
}

export const noopAuthMetrics: AuthMetrics = {};
