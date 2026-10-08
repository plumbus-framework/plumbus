import type { AuditService } from '../types/audit.js';
import type { LoggerService } from '../types/context.js';

/**
 * Records an outbox-dispatch or event-delivery audit entry. These entries are
 * best-effort bookkeeping: a failed audit write is logged and never stops a
 * publish, a consumer handler, or a dead-letter write. Capabilities that run
 * inside a consumer still record (and enforce) their own audit.
 *
 * `metadata.outcome` must stay within what `createAuditService` accepts
 * (`success | failure | denied`); retry vs dead-letter detail belongs in other
 * metadata fields.
 */
export async function recordPipelineAudit(
  audit: AuditService | undefined,
  logger: LoggerService | undefined,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!audit) return;
  try {
    await audit.record(action, metadata);
  } catch (err) {
    const details = {
      action,
      eventId: metadata.eventId,
      error: err instanceof Error ? err.message : String(err),
    };
    if (logger) logger.error('Event pipeline audit write failed', details);
    else console.error('[plumbus] event pipeline audit write failed', details);
  }
}
