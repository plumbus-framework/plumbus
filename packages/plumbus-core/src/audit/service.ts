import { z } from 'zod';
import { createErrorService, isPlumbusError } from '../errors/index.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService, AuditWriter } from '../types/audit.js';
import type { AuthContext } from '../types/security.js';
import { createDatabaseAuditWriter } from './writer.js';

export interface AuditServiceConfig {
  db: PostgresJsDatabase;
  auth: AuthContext;
  /** Component name for this audit context (e.g. capability name) */
  component?: string;
  writer?: AuditWriter;
}

/**
 * Creates a persistent AuditService that writes records to PostgreSQL.
 */
export function createAuditService(config: AuditServiceConfig): AuditService {
  const { db, auth, component = 'system' } = config;
  const writer = config.writer ?? createDatabaseAuditWriter(db);

  return {
    async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
      const parsedOutcome = z
        .enum(['success', 'failure', 'denied'])
        .safeParse(metadata?.outcome ?? 'success');
      if (!parsedOutcome.success) throw createErrorService().validation('Invalid audit outcome');
      const outcome = parsedOutcome.data;
      const maskedFields = (metadata?._maskedFields as string[]) ?? undefined;

      const storedMetadata = metadata ? { ...metadata } : undefined;
      if (storedMetadata) {
        delete storedMetadata._maskedFields;
      }

      // A NUL byte (U+0000) anywhere in a metadata string reaches the jsonb writer and
      // answers 'unsupported Unicode escape sequence' — the record is lost and the
      // capability it was recording answers 500 with no audit row (Quinovium #208).
      // Postgres's jsonb parser refuses \u0000 outright, so the value cannot survive as-is;
      // the byte is named, not dropped silently.
      const sanitizeAuditMetadata = (value: unknown): unknown =>
        typeof value === 'string'
          ? value.split(String.fromCharCode(0)).join('<NUL>')
          : Array.isArray(value)
            ? value.map(sanitizeAuditMetadata)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value as Record<string, unknown>).map(([k, v]) => [
                    k,
                    sanitizeAuditMetadata(v),
                  ]),
                )
              : value;
      const event = {
        id: crypto.randomUUID(),
        actor: auth.userId ?? 'anonymous',
        tenantId: auth.tenantId,
        component,
        action: eventType,
        outcome,
        timestamp: new Date(),
        metadata: sanitizeAuditMetadata(storedMetadata) as Record<string, unknown> | undefined,
        maskedFields,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await writer.write(event);
          return;
        } catch (error) {
          // A writer that *refuses* the record throws a PlumbusError (`validation` for a payload
          // it may not hold). That is the caller's record being wrong, not the store being
          // unavailable: it is neither retried nor relabelled as a persistence failure.
          if (isPlumbusError(error)) throw error;
          if (attempt === 2)
            throw createErrorService().internal('Audit persistence failed', { cause: error });
        }
      }
    },
  };
}
