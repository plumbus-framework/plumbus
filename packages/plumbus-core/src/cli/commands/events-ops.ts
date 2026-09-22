// ── plumbus events (operational) ──
// Outbox backlog, dead-letter management, and event replay.

import type { Command } from 'commander';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { loadConfig } from '../../config/loader.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../../data/connection.js';
import { deadLetterTable, idempotencyTable, outboxTable } from '../../events/outbox.js';
import { TrustedReplayActor } from '../../types/event.js';
import { resolveRuntimeQueues } from '../../runtime/queue-factory.js';
import { info, error as logError } from '../utils.js';

async function withDb<T>(
  fn: (db: Awaited<ReturnType<typeof resolveDatabaseConnection>>['db']) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const connection = await resolveDatabaseConnection(config.database, {});
  try {
    return await fn(connection.db);
  } finally {
    await closeDatabaseConnection(connection);
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

    const config = loadConfig();
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
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit ?? '20', 10);
      try {
        const rows = await withDb(async (db) =>
          db.select().from(deadLetterTable).orderBy(desc(deadLetterTable.failedAt)).limit(limit),
        );
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        for (const row of rows) {
          info(
            `${row.id} ${row.eventType} consumer=${row.consumerId ?? 'n/a'} retries=${row.retryCount}`,
          );
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
          const config = loadConfig();
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
        });
        info(`Re-published dead-letter ${id} to events queue`);
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
          const config = loadConfig();
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
