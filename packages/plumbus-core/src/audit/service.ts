import { z } from 'zod';
import { createErrorService, isPlumbusError } from '../errors/index.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditBatchEntry, AuditEvent, AuditService, AuditWriter } from '../types/audit.js';
import type { AuthContext } from '../types/security.js';
import { createDatabaseAuditWriter } from './writer.js';

export interface AuditServiceConfig {
  db: PostgresJsDatabase;
  auth: AuthContext;
  /** Component name for this audit context (e.g. capability name) */
  component?: string;
  writer?: AuditWriter;
  /**
   * Delays between background retries of a record that describes work already done and could
   * not be written at once (`recordAfterEffects`). Default {@link AUDIT_RETRY_DELAYS_MS}.
   */
  retryDelaysMs?: readonly number[];
  /**
   * Told about every such record that could not be written: `final: false` when a background
   * retry is scheduled, `final: true` when the last retry failed (or the store refused it) and
   * the record is lost. Default: an error-level log line (`[plumbus] audit record …`) carrying
   * the records. Use it to count or alert.
   */
  onWriteFailure?: (failure: AuditWriteFailure) => void;
}

/** A record of work already done that could not be written (see `recordAfterEffects`). */
export interface AuditWriteFailure {
  events: AuditEvent[];
  error: unknown;
  /** `true`: no further attempt is made; the records are only in this report. */
  final: boolean;
  /** Attempts made so far. */
  attempts: number;
}

/**
 * Default delays of the background retries of an after-effects record: 1 s, 5 s, 30 s, 2 min,
 * 10 min (about 13 minutes in all), then the record is reported lost.
 */
export const AUDIT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000];

/** What a default (database-backed) audit service needs to be re-bound to a transaction. */
interface DatabaseAuditBinding {
  auth: AuthContext;
  component: string;
  writer: AuditWriter;
}

/** Every service `createAuditService` built: its writer, retry policy and held records. */
interface FrameworkAuditState extends DatabaseAuditBinding {
  retryDelaysMs: readonly number[];
  onWriteFailure: (failure: AuditWriteFailure) => void;
  /** Success records held until the outermost hold is released (`holdAuditSuccess`). */
  hold?: { depth: number; events: AuditEvent[] };
}

/**
 * Default audit services, keyed by the service object. Only a service built without a
 * custom `writer` is here: an app-supplied writer is never re-routed through a transaction.
 */
const databaseAuditServices = new WeakMap<AuditService, DatabaseAuditBinding>();
/** Every service `createAuditService` built, custom writer or not. */
const frameworkAuditServices = new WeakMap<AuditService, FrameworkAuditState>();

function defaultWriteFailureReport(failure: AuditWriteFailure): void {
  console.error(
    failure.final
      ? '[plumbus] audit record lost: it could not be written and will not be retried'
      : '[plumbus] audit record could not be written; retrying in the background',
    {
      attempts: failure.attempts,
      error: failure.error instanceof Error ? failure.error.message : String(failure.error),
      records: failure.final
        ? failure.events
        : failure.events.map((event) => ({ id: event.id, action: event.action })),
    },
  );
}

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

/** The error `writeAuditEvent(s)` throws when the store could not take a record. */
function isPersistenceFailure(error: unknown): boolean {
  return (
    isPlumbusError(error) && (error as { message?: unknown }).message === 'Audit persistence failed'
  );
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
 * Write `events` together: the writer's `writeMany` when it has one (retried as a whole, with
 * the same ids, so a retry after a write that did land inserts nothing twice), else one
 * `writeAuditEvent` per event.
 */
async function writeAuditEvents(
  writer: AuditWriter,
  events: AuditEvent[],
  attempts = 3,
): Promise<void> {
  if (events.length === 0) return;
  if (!writer.writeMany) {
    for (const event of events) await writeAuditEvent(writer, event, attempts);
    return;
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await writer.writeMany(events);
      return;
    } catch (error) {
      if (isPlumbusError(error)) throw error;
      if (attempt === attempts - 1)
        throw createErrorService().internal('Audit persistence failed', { cause: error });
    }
  }
}

/**
 * Record `entries` through `service`: in one batch when the service has `recordMany`, else one
 * `record` per entry. For callers that write many rows at once (set-based repository writes).
 */
export async function recordAuditBatch(
  service: AuditService,
  entries: AuditBatchEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  if (service.recordMany) {
    await service.recordMany(entries);
    return;
  }
  for (const entry of entries) await service.record(entry.eventType, entry.metadata);
}

/**
 * Creates a persistent AuditService that writes records to PostgreSQL.
 */
export function createAuditService(config: AuditServiceConfig): AuditService {
  const { db, auth, component = 'system' } = config;
  const writer = config.writer ?? createDatabaseAuditWriter(db);
  const state: FrameworkAuditState = {
    auth,
    component,
    writer,
    retryDelaysMs: config.retryDelaysMs ?? AUDIT_RETRY_DELAYS_MS,
    onWriteFailure: config.onWriteFailure ?? defaultWriteFailureReport,
  };

  /** Held success records stay in the process until the hold ends; the rest are written. */
  async function write(events: AuditEvent[]): Promise<void> {
    const hold = state.hold;
    const now = hold ? events.filter((event) => event.outcome !== 'success') : events;
    if (hold) hold.events.push(...events.filter((event) => event.outcome === 'success'));
    if (now.length === 1 && now[0]) await writeAuditEvent(writer, now[0]);
    else await writeAuditEvents(writer, now);
  }

  const service: AuditService = {
    async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
      await write([buildAuditEvent(auth, component, eventType, metadata)]);
    },
    async recordMany(entries: AuditBatchEntry[]): Promise<void> {
      await write(
        entries.map((entry) => buildAuditEvent(auth, component, entry.eventType, entry.metadata)),
      );
    },
  };
  if (!config.writer) databaseAuditServices.set(service, { auth, component, writer });
  frameworkAuditServices.set(service, state);
  return service;
}

/** Retry `events` in the background with their ids; report each failure, and the loss. */
function retryInBackground(
  state: Pick<FrameworkAuditState, 'retryDelaysMs' | 'onWriteFailure'>,
  events: AuditEvent[],
  attemptWrite: () => Promise<void>,
  firstError: unknown,
): void {
  let attempts = 1;
  const report = (error: unknown, final: boolean) => {
    try {
      state.onWriteFailure({ events, error, final, attempts });
    } catch {
      // A failing reporter must not stop the retries or reach the caller.
    }
  };
  const schedule = (error: unknown) => {
    const delay = state.retryDelaysMs[attempts - 1];
    // A refusal (the record itself is invalid) is final: retrying cannot change it.
    const refused = isPlumbusError(error) && !isPersistenceFailure(error);
    if (delay === undefined || refused) {
      report(error, true);
      return;
    }
    report(error, false);
    const timer = setTimeout(() => {
      attempts += 1;
      attemptWrite().then(
        () => undefined,
        (next: unknown) => schedule(next),
      );
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule(firstError);
}

/**
 * Record `entries` that describe work already done (committed, or done outside any
 * transaction): never throws because the store is unavailable. A record that cannot be written
 * at once is retried in the background with the same ids (so a retry after a write that did
 * land inserts nothing twice) and reported through the service's `onWriteFailure` — by default
 * an error-level log line — on each failure and when it is finally given up. A service not built
 * by `createAuditService` is retried through its `record` / `recordMany`.
 *
 * For `success` records written after the work they describe. `failure` and `denied` records
 * go through `record`, which throws when they cannot be written.
 */
export async function recordAfterEffects(
  service: AuditService,
  entries: AuditBatchEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const state = frameworkAuditServices.get(service);
  if (!state) {
    const write = () => recordAuditBatch(service, entries);
    try {
      await write();
    } catch (error) {
      retryInBackground(
        { retryDelaysMs: AUDIT_RETRY_DELAYS_MS, onWriteFailure: defaultWriteFailureReport },
        entries.map((entry) => ({
          component: 'unknown',
          action: entry.eventType,
          outcome: 'success' as const,
          metadata: entry.metadata,
        })),
        write,
        error,
      );
    }
    return;
  }
  const events = entries.map((entry) =>
    buildAuditEvent(state.auth, state.component, entry.eventType, entry.metadata),
  );
  if (state.hold) {
    const held = events.filter((event) => event.outcome === 'success');
    state.hold.events.push(...held);
    const others = events.filter((event) => event.outcome !== 'success');
    if (others.length === 0) return;
    await writeOrRetry(state, others);
    return;
  }
  await writeOrRetry(state, events);
}

async function writeOrRetry(state: FrameworkAuditState, events: AuditEvent[]): Promise<void> {
  try {
    // Three quick attempts, as `record` makes; then the background retries, one attempt each.
    await writeAuditEvents(state.writer, events);
  } catch (error) {
    retryInBackground(state, events, () => writeAuditEvents(state.writer, events, 1), error);
  }
}

/** A hold on an audit service's success records (`holdAuditSuccess`). */
export interface AuditSuccessHold {
  /**
   * End this hold. When it is the outermost one, the held success records are written in one
   * batch through `recordAfterEffects` semantics (never throws; retried and reported).
   */
  release(): Promise<void>;
}

/**
 * Hold the `success` records `service` is asked to write — by `ctx.audit`, by the repositories
 * and the event emitter built on it — in the process until `release()`, then write them
 * together. `failure` and `denied` records are written at once, as always. For work that runs
 * outside a framework transaction and holds a connection of its own (its own tenant
 * transaction), so audit inserts do not take a second pool connection while it runs. Holds nest:
 * only the outermost release writes. Returns `undefined` for a service not built by
 * `createAuditService`, which keeps writing at once.
 *
 * A held record is lost if the process dies before the release; it is never dropped otherwise.
 */
export function holdAuditSuccess(service: AuditService): AuditSuccessHold | undefined {
  const state = frameworkAuditServices.get(service);
  if (!state) return undefined;
  state.hold ??= { depth: 0, events: [] };
  state.hold.depth += 1;
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const hold = state.hold;
      if (!hold) return;
      hold.depth -= 1;
      if (hold.depth > 0) return;
      state.hold = undefined;
      if (hold.events.length > 0) await writeOrRetry(state, hold.events);
    },
  };
}

/**
 * An audit service bound to one open transaction, and the hooks the transaction runner
 * calls once that transaction has ended.
 */
/**
 * Whether `service` is a framework database-backed audit service, i.e. one
 * {@link bindAuditServiceToTransaction} can bind to a transaction.
 */
export function isTransactionBindableAuditService(service: AuditService): boolean {
  return databaseAuditServices.has(service);
}

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

  async function recordEvents(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (!open) {
      await writeAuditEvents(outerWriter, events);
      return;
    }
    const success = events.filter((event) => event.outcome === 'success');
    const others = events.filter((event) => event.outcome !== 'success');
    // A failed statement aborts the transaction, so a retry inside it cannot succeed.
    if (success.length > 0) await writeAuditEvents(txWriter, success, 1);
    if (others.length === 0) return;
    try {
      await writeAuditEvents(txWriter, others, 1);
      kept.push(...others);
    } catch (error) {
      if (isPlumbusError(error) && !isPersistenceFailure(error)) throw error;
      // Written after the transaction ends, whichever way it ends.
      pending.push(...others);
    }
  }

  return {
    audit: {
      async recordMany(entries: AuditBatchEntry[]): Promise<void> {
        await recordEvents(
          entries.map((entry) => buildAuditEvent(auth, component, entry.eventType, entry.metadata)),
        );
      },
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
