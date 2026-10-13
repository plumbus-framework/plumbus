import type { AuditEvent, AuditWriter } from '@plumbus/core';

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

export const AUTH_AUDIT_COMPONENT = 'plumbus.auth';

export function auditOutcomeFor(event: string): AuditEvent['outcome'] {
  if (event === AuthAuditEvents.LoginDenied) return 'denied';
  if (event === AuthAuditEvents.LoginFailed || event === AuthAuditEvents.LoginCancelled) {
    return 'failure';
  }
  return 'success';
}

/**
 * Message and code of a failed write. Drizzle wraps driver errors in a
 * "Failed query: …" error whose `cause` carries the database reason.
 */
export function describeAuditWriteError(err: unknown): { error: string; code?: string } {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
  const source = cause ?? err;
  const error = source instanceof Error ? source.message : String(source);
  const code = (source as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { error, code } : { error };
}

export interface AuthAuditEmitter {
  emit(event: string, metadata?: AuthAuditMetadata): Promise<void>;
}

export function createAuthAuditEmitter(opts: {
  writer?: AuditWriter;
  onFailure?: () => void;
}): AuthAuditEmitter {
  return {
    async emit(event, metadata) {
      try {
        if (!opts.writer) return;
        await opts.writer.write({
          component: AUTH_AUDIT_COMPONENT,
          action: event,
          outcome: auditOutcomeFor(event),
          metadata: sanitizeAuditMetadata(metadata),
        });
      } catch (err) {
        console.error(
          `[@plumbus/auth] audit write failed for ${event}`,
          describeAuditWriteError(err),
        );
        opts.onFailure?.();
      }
    },
  };
}
