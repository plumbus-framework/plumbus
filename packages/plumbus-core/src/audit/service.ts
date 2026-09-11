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

      const event = {
        id: crypto.randomUUID(),
        actor: auth.userId ?? 'anonymous',
        tenantId: auth.tenantId,
        component,
        action: eventType,
        outcome,
        timestamp: new Date(),
        metadata: storedMetadata,
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
