// ── plumbus worker ──
// Dedicated worker process for background queues, flows, and jobs.

import type { Command } from 'commander';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  closeDatabaseConnection,
  resolveDatabaseConnection,
  type DatabaseConnection,
} from '../../data/connection.js';
import { deadLetterTable, outboxTable } from '../../events/outbox.js';
import { PromptRegistry } from '../../ai/prompt-registry.js';
import { loadConfig, validateConfig } from '../../config/loader.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import {
  discoverRuntimeResources,
  needsWorkerPool,
  resolveRuntimeRole,
} from '../../runtime/bootstrap.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { resolveRuntimeQueues, shouldUseRedisBackend } from '../../runtime/queue-factory.js';
import { startWorkerPool } from '../../runtime/start-worker-pool.js';
import { createWorkerHealthServer } from '../../runtime/worker-health.js';
import { createPlumbusMetrics } from '../../observability/metrics.js';
import type { WorkerPool } from '../../worker/bootstrap.js';
import { logHookError } from '../../errors/hook-log.js';
import { info, error as logError } from '../utils.js';

export interface WorkerStartOptions {
  healthPort?: string;
  host?: string;
}

/**
 * Start a worker-only process (no HTTP API).
 * Used with PLUMBUS_RUNTIME_ROLE=worker or `plumbus worker`.
 */
export async function startWorkerProcess(
  options: WorkerStartOptions & { db?: PostgresJsDatabase; connection?: DatabaseConnection },
): Promise<{ shutdown: () => Promise<void> }> {
  const config = loadConfig();
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`);
  }

  const runtimeRole = resolveRuntimeRole('worker');
  if (runtimeRole !== 'worker') {
    info(`Runtime role resolved to "${runtimeRole}" (expected worker)`);
  }

  info('Plumbus Worker');
  const resources = await discoverRuntimeResources();
  if (!needsWorkerPool(resources)) {
    info('No background work detected — worker will still drain outbox if events exist');
  }

  const capabilities = new CapabilityRegistry();
  capabilities.registerAll(resources.capabilities);
  const entities = new EntityRegistry();
  entities.registerAll(resources.entities);
  const events = new EventRegistry();
  events.registerAll(resources.events);
  const flows = new FlowRegistry();
  flows.registerAll(resources.flows);
  const consumers = new ConsumerRegistry();
  const promptRegistry = new PromptRegistry();
  for (const prompt of resources.prompts) {
    promptRegistry.register(prompt);
  }

  const dbConnection = await resolveDatabaseConnection(config.database, options);
  const db = dbConnection.db;
  info('Database connected');

  const extensions = await loadServerExtensions();
  const queues = await resolveRuntimeQueues(config, {
    onWarning: (message) => info(`Queue: ${message}`),
  });

  const metrics = createPlumbusMetrics();

  const healthPort = parseInt(options.healthPort ?? '3001', 10);
  const healthHost = options.host ?? '0.0.0.0';

  const workerPool: WorkerPool = await startWorkerPool({
    config,
    db,
    queues,
    capabilities,
    entities,
    events,
    flows,
    consumers,
    promptRegistry,
    extensions,
    metrics,
  });
  info('Worker pool started');

  const health = createWorkerHealthServer({
    port: healthPort,
    host: healthHost,
    db,
    queues,
    workerPool,
    metrics,
  });
  const healthAddress = await health.start();
  info(`Worker health: ${healthAddress}/health`);
  info(`Worker metrics: ${healthAddress}/metrics`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('Graceful shutdown initiated...');
    await health.stop();
    await workerPool.stop();
    await closeDatabaseConnection(dbConnection);
    info('Worker stopped');
  };

  const onSignal = () => {
    void shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (extensions.onProcessError) {
    const errorHook = extensions.onProcessError;
    process.on('uncaughtException', (err) => {
      logError(`Uncaught exception: ${err.message}`);
      Promise.resolve(
        errorHook({ source: 'uncaughtException', message: err.message, stack: err.stack }),
      ).catch((hookErr) => {
        logHookError('onProcessError', hookErr);
      });
    });
    process.on('unhandledRejection', (reason) => {
      const message =
        reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection');
      logError(`Unhandled rejection: ${message}`);
      Promise.resolve(
        errorHook({
          source: 'unhandledRejection',
          message,
          stack: reason instanceof Error ? reason.stack : undefined,
        }),
      ).catch((hookErr) => {
        logHookError('onProcessError', hookErr);
      });
    });
  }

  return { shutdown };
}

export function registerWorkerCommand(program: Command): void {
  const worker = program.command('worker').description('Background worker process');

  worker
    .command('start', { isDefault: true })
    .description('Start the worker pool (default)')
    .option('--health-port <port>', 'Health/metrics HTTP port', '3001')
    .option('-H, --host <host>', 'Health server host', '0.0.0.0')
    .action(async (opts: WorkerStartOptions & { healthPort?: string }) => {
      try {
        await startWorkerProcess({
          healthPort: opts.healthPort,
          host: opts.host,
        });
      } catch (err) {
        logError(`Failed to start worker: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  worker
    .command('status')
    .description('Summarize worker-related configuration (static check)')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      const resources = await discoverRuntimeResources();
      const role = resolveRuntimeRole('worker');
      const queues = await resolveRuntimeQueues(config, { preferInMemory: true });
      const configuredDurable = shouldUseRedisBackend(config);

      let dbProbes: {
        outboxPending?: number;
        deadLetterCount?: number;
        queueDepths?: { events: number; flows: number; jobs: number } | null;
        dbAvailable: boolean;
      } = { dbAvailable: false };

      try {
        const connection = await resolveDatabaseConnection(config.database, {});
        try {
          const pending = await connection.db
            .select({ count: sql<number>`count(*)::int` })
            .from(outboxTable)
            .where(eq(outboxTable.status, 'pending'));
          const dlq = await connection.db
            .select({ count: sql<number>`count(*)::int` })
            .from(deadLetterTable);
          let queueDepths: { events: number; flows: number; jobs: number } | null = null;
          if (configuredDurable) {
            const liveQueues = await resolveRuntimeQueues(config);
            try {
              queueDepths = liveQueues.getDepths ? await liveQueues.getDepths() : null;
            } finally {
              await liveQueues.close();
            }
          }
          dbProbes = {
            dbAvailable: true,
            outboxPending: pending[0]?.count ?? 0,
            deadLetterCount: dlq[0]?.count ?? 0,
            queueDepths,
          };
        } finally {
          await closeDatabaseConnection(connection);
        }
      } catch {
        dbProbes = { dbAvailable: false };
      }

      const summary = {
        runtimeRole: role,
        needsWorkerPool: needsWorkerPool(resources),
        queueBackend: queues.backend,
        queueDurable: configuredDurable,
        components: {
          outboxDispatcher: true,
          eventWorker: true,
          jobWorker: resources.capabilities.some((c) => c.kind === 'job'),
          flowRunner: resources.flows.length > 0,
          flowScheduler: resources.flows.some((f) => f.schedule),
          flowStepConsumer: configuredDurable && resources.flows.length > 0,
          flowDelayedPromoter: configuredDurable && resources.flows.length > 0,
        },
        capabilities: resources.capabilities.length,
        eventHandlers: resources.capabilities.filter((c) => c.kind === 'eventHandler').length,
        jobs: resources.capabilities.filter((c) => c.kind === 'job').length,
        flows: resources.flows.length,
        events: resources.events.length,
        probes: dbProbes,
      };
      await queues.close();
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      info(`Runtime role: ${summary.runtimeRole}`);
      info(`Needs worker pool: ${summary.needsWorkerPool}`);
      info(`Queue backend: ${summary.queueBackend} (durable: ${summary.queueDurable})`);
      info(
        `Worker components: dispatcher, eventWorker${summary.components.jobWorker ? ', jobWorker' : ''}${summary.components.flowRunner ? ', flowRunner' : ''}${summary.components.flowScheduler ? ', scheduler' : ''}${summary.components.flowStepConsumer ? ', flowStepConsumer' : ''}${summary.components.flowDelayedPromoter ? ', delayedPromoter' : ''}`,
      );
      info(
        `Resources: ${summary.capabilities} capabilities, ${summary.flows} flows, ${summary.events} events`,
      );
      if (dbProbes.dbAvailable) {
        info(`Outbox pending: ${dbProbes.outboxPending ?? 0}`);
        info(`Dead letter: ${dbProbes.deadLetterCount ?? 0}`);
        if (dbProbes.queueDepths) {
          const d = dbProbes.queueDepths;
          info(`Queue depths — events: ${d.events}, flows: ${d.flows}, jobs: ${d.jobs}`);
        }
      } else {
        info('Database probes unavailable (connection failed)');
      }
    });
}
