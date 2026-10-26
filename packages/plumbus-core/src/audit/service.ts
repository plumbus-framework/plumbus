import { z } from 'zod';
import { createErrorService, isPlumbusError } from '../errors/index.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditEvent, AuditService, AuditWriter } from '../types/audit.js';
import type { AuthContext } from '../types/security.js';
import { createDatabaseAuditWriter } from './writer.js';

export interface AuditServiceConfig {
  db: PostgresJsDatabase;
  auth: AuthContext;
  /** Component name for this audit context (e.g. capability name) */
  component?: string;
  writer?: AuditWriter;
}

/** What a default (database-backed) audit service needs to be re-bound to a transaction. */
interface DatabaseAuditBinding {
  auth: AuthContext;
  component: string;
  writer: AuditWriter;
}

/**
 * Default audit services, keyed by the service object. Only a service built without a
 * custom `writer` is here: an app-supplied writer is never re-routed through a transaction.
 */
const databaseAuditServices = new WeakMap<AuditService, DatabaseAuditBinding>();

// A NUL byte (U+0000) anywhere in a metadata string reaches the jsonb writer and
// answers 'unsupported Unicode escape sequence' — the record is lost and the
// capability it was recording answers 500 with no audit row.
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

/** Build the stored event for one `record` call (validated outcome, sanitized metadata). */
function buildAuditEvent(
  auth: AuthContext,
  component: string,
  eventType: string,
  metadata?: Record<string, unknown>,
): AuditEvent {
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
  return {
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
}

/** Write with up to `attempts` tries; a PlumbusError (a refused record) is never retried. */
async function writeAuditEvent(
  writer: AuditWriter,
  event: AuditEvent,
  attempts = 3,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await writer.write(event);
      return;
    } catch (error) {
      // A writer that *refuses* the record throws a PlumbusError (`validation` for a payload
      // it may not hold). That is the caller's record being wrong, not the store being
      // unavailable: it is neither retried nor relabelled as a persistence failure.
      if (isPlumbusError(error)) throw error;
      if (attempt === attempts - 1)
        throw createErrorService().internal('Audit persistence failed', { cause: error });
    }
  }
}

/**
 * Creates a persistent AuditService that writes records to PostgreSQL.
 */
export function createAuditService(config: AuditServiceConfig): AuditService {
  const { db, auth, component = 'system' } = config;
  const writer = config.writer ?? createDatabaseAuditWriter(db);

  const service: AuditService = {
    async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
      await writeAuditEvent(writer, buildAuditEvent(auth, component, eventType, metadata));
    },
  };
  if (!config.writer) databaseAuditServices.set(service, { auth, component, writer });
  return service;
}

/**
 * An audit service bound to one open transaction, and the hooks the transaction runner
 * calls once that transaction has ended.
 */
export interface TransactionAuditBinding {
  /** Writes through the transaction while it is open; through the outer writer after it ended. */
  readonly audit: AuditService;
  /** The transaction committed: later writes go to the outer writer. */
  committed(): Promise<void>;
  /**
   * The transaction rolled back: `failure` and `denied` records written inside it are
   * written again (same ids) through the outer writer; `success` records are dropped with
   * the work they described. Later writes go to the outer writer.
   */
  rolledBack(): Promise<void>;
}

/**
 * Bind a default audit service (built by `createAuditService` without a custom `writer`) to
 * an open transaction, so audit rows inside it use the transaction's connection and commit
 * with the data they describe — instead of checking out a second pool connection while the
 * transaction holds one. Returns `undefined` for any other audit service, which keeps
 * writing where it always did.
 */
export function bindAuditServiceToTransaction(
  outer: AuditService,
  tx: PostgresJsDatabase,
): TransactionAuditBinding | undefined {
  const binding = databaseAuditServices.get(outer);
  if (!binding) return undefined;
  const { auth, component, writer: outerWriter } = binding;
  const txWriter = createDatabaseAuditWriter(tx);
  let open = true;
  /** failure/denied records written inside the transaction, kept until it ends. */
  const kept: AuditEvent[] = [];
  /** failure/denied records the transaction could not take (e.g. it was already aborted). */
  const pending: AuditEvent[] = [];

  async function flush(events: AuditEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await writeAuditEvent(outerWriter, event);
      } catch (error) {
        // The transaction's own outcome already stands; a lost record is reported, not thrown.
        console.error('[plumbus] audit record could not be written after the transaction', {
          action: event.action,
          outcome: event.outcome,
          error,
        });
      }
    }
  }

  return {
    audit: {
      async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
        const event = buildAuditEvent(auth, component, eventType, metadata);
        if (!open) {
          await writeAuditEvent(outerWriter, event);
          return;
        }
        if (event.outcome === 'success') {
          // A failed statement aborts the transaction, so a retry inside it cannot succeed.
          await writeAuditEvent(txWriter, event, 1);
          return;
        }
        try {
          await txWriter.write(event);
          kept.push(event);
        } catch (error) {
          if (isPlumbusError(error)) throw error;
          // Written after the transaction ends, whichever way it ends.
          pending.push(event);
        }
      },
    },
    async committed(): Promise<void> {
      open = false;
      kept.length = 0;
      await flush(pending.splice(0));
    },
    async rolledBack(): Promise<void> {
      open = false;
      await flush([...kept.splice(0), ...pending.splice(0)]);
    },
  };
}
