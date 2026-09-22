export const AuthAuditEvents = {
  LoginStarted: 'auth.login.started',
  LoginCancelled: 'auth.login.cancelled',
  LoginFailed: 'auth.login.failed',
  LoginDenied: 'auth.login.denied',
  LoginSucceeded: 'auth.login.succeeded',
  SessionReplaced: 'auth.session.replaced',
  SessionExpired: 'auth.session.expired',
  SessionRevoked: 'auth.session.revoked',
  Logout: 'auth.logout',
} as const;

export type AuthAuditMetadata = {
  providerId?: string;
  reason?: string;
  requestId?: string;
  durationMs?: number;
};

const ALLOWED_METADATA_KEYS = new Set(['providerId', 'reason', 'requestId', 'durationMs']);

export function sanitizeAuditMetadata(
  metadata?: Record<string, unknown>,
): AuthAuditMetadata | undefined {
  if (!metadata) return undefined;
  const out: AuthAuditMetadata = {};
  for (const key of ALLOWED_METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface AuthAuditEmitter {
  emit(event: string, metadata?: AuthAuditMetadata): Promise<void>;
}

export function createAuthAuditEmitter(opts: {
  writer?: { write(event: { action: string; metadata?: Record<string, unknown> }): Promise<void> };
  onFailure?: () => void;
}): AuthAuditEmitter {
  return {
    async emit(event, metadata) {
      try {
        if (!opts.writer) return;
        await opts.writer.write({
          action: event,
          metadata: sanitizeAuditMetadata(metadata),
        });
      } catch {
        console.error(`[@plumbus/auth] audit write failed for ${event}`);
        opts.onFailure?.();
      }
    },
  };
}
