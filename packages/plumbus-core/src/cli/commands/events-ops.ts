// ── plumbus events (operational) ──
// Outbox backlog, dead-letter management, and event replay.

import type { Command } from 'commander';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { loadAppConfig } from '../../config/index.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../../data/connection.js';
import {
  EventDeadLetterResolution,
  resolveEventDeadLetter,
  resolveEventDeadLetters,
} from '../../events/dead-letter-resolution.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { withDataPlane } from '../../tenancy/data-plane-resolver.js';
import { deadLetterTable, idempotencyTable, outboxTable } from '../../events/outbox.js';
import { TrustedReplayActor } from '../../types/event.js';
import { resolveRuntimeQueues } from '../../runtime/queue-factory.js';
import { info, error as logError } from '../utils.js';

async function withDb<T>(
  fn: (db: Awaited<ReturnType<typeof resolveDatabaseConnection>>['db']) => Promise<T>,
): Promise<T> {
  const config = await loadAppConfig();
  const connection = await resolveDatabaseConnection(config.database, {});
  try {
    return await fn(connection.db);
  } finally {
    await closeDatabaseConnection(connection);
  }
}

/** Which databases a dead-letter command works on. */
export interface DeadLetterTargetOptions {
  /** One tenant plane, reached through `app/server.ts`'s `dataPlaneResolver`. */
  tenant?: string;
  /** Every plane `app/server.ts`'s `listTenantRefs` lists. */
  allTenants?: boolean;
}

type CommandDb = Awaited<ReturnType<typeof resolveDatabaseConnection>>['db'];

/**
 * Run `fn` on the pool's database, or on the tenant planes the options name (through the
 * `dataPlaneResolver` / `listTenantRefs` exported from `app/server.ts`), one plane at a time.
 * `fn` gets the database and a label (`pool` or `tenant-plane:<ref>`).
 */
export async function withDeadLetterTargets<T>(
  opts: DeadLetterTargetOptions,
  fn: (db: CommandDb, label: string) => Promise<T>,
  loadExtensions: (
    cwd: string,
  ) => Promise<Awaited<ReturnType<typeof loadServerExtensions>>> = loadServerExtensions,
): Promise<Array<{ label: string; result: T }>> {
  if (opts.tenant !== undefined && opts.allTenants) {
    throw new Error('Use either --tenant <ref> or --all-tenants, not both');
  }
  if (opts.tenant === undefined && !opts.allTenants) {
    return [{ label: 'pool', result: await withDb((db) => fn(db, 'pool')) }];
  }
  const ext = await loadExtensions(process.cwd());
  const resolver = ext.dataPlaneResolver;
  if (!resolver) {
    throw new Error('app/server.ts exports no dataPlaneResolver; tenant planes cannot be reached');
  }
  try {
    let refs: string[];
    if (opts.tenant !== undefined) {
      refs = [opts.tenant];
    } else {
      if (!ext.listTenantRefs) {
        throw new Error('app/server.ts exports no listTenantRefs; use --tenant <ref> per plane');
      }
      refs = [...(await ext.listTenantRefs())];
    }
    const results: Array<{ label: string; result: T }> = [];
    for (const ref of refs) {
      const label = `tenant-plane:${ref}`;
      const result = await withDataPlane(resolver, ref, (handle) => fn(handle.db, label), {
        purpose: 'background',
      });
      results.push({ label, result });
    }
    return results;
  } finally {
    const closable = resolver as { close?: () => Promise<void> };
    await closable.close?.().catch(() => undefined);
  }
}

export async function getEventsStatus(): Promise<Record<string, unknown>> {
  return withDb(async (db) => {
    const pending = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxTable)
      .where(eq(outboxTable.status, 'pending'));
    const dlq = await db.select({ count: sql<number>`count(*)::int` }).from(deadLetterTable);
    const oldest = await db
      .select({ occurredAt: outboxTable.occurredAt })
      .from(outboxTable)
      .where(eq(outboxTable.status, 'pending'))
      .orderBy(outboxTable.occurredAt)
      .limit(1);

    const config = await loadAppConfig();
    const queues = await resolveRuntimeQueues(config, { preferInMemory: true });
    const queueDepths = queues.getDepths ? await queues.getDepths() : null;

    return {
      outboxPending: pending[0]?.count ?? 0,
      deadLetterCount: dlq[0]?.count ?? 0,
      oldestPendingAt: oldest[0]?.occurredAt?.toISOString() ?? null,
      queueBackend: queues.backend,
      queueDepths,
    };
  });
}

export interface ResolveAllOptions extends DeadLetterTargetOptions {
  eventType?: string;
  consumer?: string;
  before?: string;
  every?: boolean;
  note?: string;
  actor?: string;
}

/**
 * `plumbus events dead-letter resolve-all`: settle every unresolved dead letter matching the
 * filters on each target database, a thousand rows a statement until none is left. A call
 * without a filter must say `--every`.
 */
export async function resolveAllDeadLetters(
  opts: ResolveAllOptions,
  targets: typeof withDeadLetterTargets = withDeadLetterTargets,
): Promise<Array<{ label: string; result: number }>> {
  const hasFilter =
    opts.eventType !== undefined || opts.consumer !== undefined || opts.before !== undefined;
  if (!hasFilter && !opts.every) {
    throw new Error('Give --event-type, --consumer or --before, or --every to settle every row');
  }
  let failedBefore: Date | undefined;
  if (opts.before !== undefined) {
    failedBefore = new Date(opts.before);
    if (Number.isNaN(failedBefore.getTime()))
      throw new Error(`--before is not a date: ${opts.before}`);
  }
  const batch = 1000;
  return targets(opts, async (db) => {
    let total = 0;
    for (;;) {
      const marked = await resolveEventDeadLetters(
        db,
        {
          ...(opts.eventType !== undefined ? { eventType: opts.eventType } : {}),
          ...(opts.consumer !== undefined ? { consumerId: opts.consumer } : {}),
          ...(failedBefore ? { failedBefore } : {}),
          limit: batch,
        },
        {
          actor: opts.actor ?? 'cli',
          resolution: EventDeadLetterResolution.Discarded,
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        },
      );
      total += marked;
      if (marked < batch) return total;
    }
  });
}

export function registerEventsOpsCommands(eventsCmd: Command): void {
  eventsCmd
    .command('status')
    .description('Outbox backlog, DLQ count, queue backend summary')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const status = await getEventsStatus();
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        info(`Outbox pending: ${status.outboxPending}`);
        info(`Dead letter: ${status.deadLetterCount}`);
        info(`Oldest pending: ${status.oldestPendingAt ?? 'n/a'}`);
        info(`Queue backend: ${status.queueBackend}`);
        if (status.queueDepths) {
          const d = status.queueDepths as { events: number; flows: number; jobs: number };
          info(`Queue depths — events: ${d.events}, flows: ${d.flows}, jobs: ${d.jobs}`);
        }
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  const dlq = eventsCmd.command('dead-letter').description('Manage event dead-letter queue');

  dlq
    .command('list')
    .description('List event dead-letter rows')
    .option('--limit <n>', 'Max rows', '20')
    .option('--json', 'Output JSON')
    .option('--tenant <ref>', 'Read one tenant plane (app/server.ts dataPlaneResolver)')
    .option('--all-tenants', 'Read every plane app/server.ts listTenantRefs lists')
    .action(async (opts: { limit?: string; json?: boolean } & DeadLetterTargetOptions) => {
      const limit = parseInt(opts.limit ?? '20', 10);
      try {
        const perTarget = await withDeadLetterTargets(opts, (db) =>
          db.select().from(deadLetterTable).orderBy(desc(deadLetterTable.failedAt)).limit(limit),
        );
        if (opts.json) {
          const rows =
            perTarget.length === 1 && perTarget[0]?.label === 'pool'
              ? perTarget[0].result
              : perTarget.flatMap(({ label, result }) =>
                  result.map((row) => ({ plane: label, ...row })),
                );
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        for (const { label, result } of perTarget) {
          if (perTarget.length > 1 || label !== 'pool') info(`${label}: ${result.length} row(s)`);
          for (const row of result) {
            const resolution = (row.metadata as { resolution?: unknown } | null)?.resolution;
            info(
              `${row.id} ${row.eventType} consumer=${row.consumerId ?? 'n/a'} retries=${row.retryCount}${typeof resolution === 'string' ? ` resolved=${resolution}` : ''}`,
            );
          }
        }
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  dlq
    .command('retry <id>')
    .description('Re-publish a dead-letter event to the events queue')
    .action(async (id: string) => {
      try {
        await withDb(async (db) => {
          const rows = await db
            .select()
            .from(deadLetterTable)
            .where(eq(deadLetterTable.id, id))
            .limit(1);
          const row = rows[0];
          if (!row) {
            throw new Error(`Dead-letter row "${id}" not found`);
          }
          const config = await loadAppConfig();
          const queues = await resolveRuntimeQueues(config);
          const dlqMeta = row.metadata as { tenantId?: string | null } | null;
          await queues.events.publish({
            id: row.eventId,
            eventType: row.eventType,
            version: '1',
            occurredAt: new Date(),
            actor: TrustedReplayActor.OpsRetry,
            tenantId: dlqMeta?.tenantId ?? undefined,
            correlationId: row.eventId,
            payload: row.payload as Record<string, unknown>,
            metadata: dlqMeta?.tenantId != null ? { tenantId: dlqMeta.tenantId } : undefined,
          });
          await queues.close();
          // Settled: a delivery that fails again writes a new dead letter.
          await resolveEventDeadLetter(db, id, {
            actor: 'cli',
            resolution: EventDeadLetterResolution.Retried,
          });
        });
        info(`Re-published dead-letter ${id} to events queue`);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  dlq
    .command('resolve <id>')
    .description(
      'Mark a dead-letter row resolved without re-publishing it (retention may delete it)',
    )
    .option('--note <text>', 'Why it needs no redelivery')
    .option('--actor <name>', 'Who resolved it', 'cli')
    .option('--tenant <ref>', 'The row is on this tenant plane (app/server.ts dataPlaneResolver)')
    .action(async (id: string, opts: { note?: string; actor?: string; tenant?: string }) => {
      try {
        const [target] = await withDeadLetterTargets({ tenant: opts.tenant }, (db) =>
          resolveEventDeadLetter(db, id, {
            actor: opts.actor ?? 'cli',
            resolution: EventDeadLetterResolution.Discarded,
            ...(opts.note !== undefined ? { note: opts.note } : {}),
          }),
        );
        if (!target?.result) throw new Error(`No unresolved dead-letter row "${id}"`);
        info(`Resolved dead-letter ${id}${target.label === 'pool' ? '' : ` on ${target.label}`}`);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  dlq
    .command('resolve-all')
    .description(
      'Mark every unresolved dead-letter row matching the filters resolved (discarded), in batches',
    )
    .option('--event-type <type>', 'Only rows of this event type')
    .option('--consumer <id>', 'Only rows of this consumer')
    .option('--before <iso-date>', 'Only rows that failed before this instant')
    .option('--every', 'No filter: every unresolved row (required when no filter is given)')
    .option('--note <text>', 'Why they need no redelivery')
    .option('--actor <name>', 'Who resolved them', 'cli')
    .option('--tenant <ref>', 'One tenant plane (app/server.ts dataPlaneResolver)')
    .option('--all-tenants', 'Every plane app/server.ts listTenantRefs lists')
    .action(async (opts: ResolveAllOptions) => {
      try {
        const totals = await resolveAllDeadLetters(opts);
        for (const { label, result } of totals) info(`${label}: resolved ${result}`);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  eventsCmd
    .command('replay <eventId>')
    .description('Re-dispatch outbox event(s) to the queue')
    .option('--consumer <id>', 'Clear idempotency for this consumer before replay')
    .option('--from <date>', 'Bulk replay dispatched events from ISO date')
    .action(async (eventId: string, opts: { consumer?: string; from?: string }) => {
      try {
        await withDb(async (db) => {
          const config = await loadAppConfig();
          const queues = await resolveRuntimeQueues(config);
          if (opts.from) {
            const rows = await db
              .select()
              .from(outboxTable)
              .where(
                and(
                  eq(outboxTable.status, 'dispatched'),
                  gte(outboxTable.occurredAt, new Date(opts.from)),
                ),
              )
              .limit(100);
            for (const row of rows) {
              if (opts.consumer) {
                await db
                  .delete(idempotencyTable)
                  .where(
                    and(
                      eq(idempotencyTable.eventId, row.id),
                      eq(idempotencyTable.consumerId, opts.consumer),
                    ),
                  );
              }
              await queues.events.publish({
                id: row.id,
                eventType: row.eventType,
                version: row.version,
                occurredAt: row.occurredAt,
                actor: TrustedReplayActor.OutboxReplay,
                tenantId: row.tenantId ?? undefined,
                correlationId: row.correlationId,
                payload: row.payload as Record<string, unknown>,
              });
            }
            info(`Replayed ${rows.length} outbox event(s)`);
          } else {
            const rows = await db
              .select()
              .from(outboxTable)
              .where(eq(outboxTable.id, eventId))
              .limit(1);
            const row = rows[0];
            if (!row) {
              throw new Error(`Outbox event "${eventId}" not found`);
            }
            if (opts.consumer) {
              await db
                .delete(idempotencyTable)
                .where(
                  and(
                    eq(idempotencyTable.eventId, eventId),
                    eq(idempotencyTable.consumerId, opts.consumer),
                  ),
                );
            }
            await queues.events.publish({
              id: row.id,
              eventType: row.eventType,
              version: row.version,
              occurredAt: row.occurredAt,
              actor: TrustedReplayActor.OutboxReplay,
              tenantId: row.tenantId ?? undefined,
              correlationId: row.correlationId,
              payload: row.payload as Record<string, unknown>,
            });
            info(`Replayed outbox event ${eventId}`);
          }
          await queues.close();
        });
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
