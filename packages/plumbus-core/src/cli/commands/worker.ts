// ── plumbus worker ──
// Dedicated worker process for background queues, flows, and jobs.

import { installKeepAliveProcessHandlers } from '../../runtime/process-errors.js';
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
import { loadAppConfig, validateConfig } from '../../config/index.js';
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
import { bootLogger, runAppBoot } from '../../runtime/app-boot.js';
import { resolveShutdownSettings, runGracefulShutdown } from '../../runtime/graceful-shutdown.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { resolveRuntimeQueues, shouldUseRedisBackend } from '../../runtime/queue-factory.js';
import { startWorkerPool } from '../../runtime/start-worker-pool.js';
import { createWorkerHealthServer } from '../../runtime/worker-health.js';
import { createPlumbusMetrics } from '../../observability/metrics.js';
import type { WorkerPool } from '../../worker/bootstrap.js';
import { info, error as logError, warn } from '../utils.js';

export interface WorkerStartOptions {
  healthPort?: string;
  host?: string;
}

/**
 * Resolve the worker health listen port from `--health-port` or `PLUMBUS_WORKER_HEALTH_PORT`.
 * No default port is assumed.
 */
export function resolveWorkerHealthPort(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromFlag = explicit?.trim();
  const raw = fromFlag || env.PLUMBUS_WORKER_HEALTH_PORT?.trim();
  if (!raw) {
    throw new Error(
      '--health-port is required (or set PLUMBUS_WORKER_HEALTH_PORT). No default listen port is assumed.',
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port "${raw}". Expected an integer in 1-65535 from --health-port or PLUMBUS_WORKER_HEALTH_PORT.`,
    );
  }
  return port;
}

/**
 * Start a worker-only process (no HTTP API).
 * Used with PLUMBUS_RUNTIME_ROLE=worker or `plumbus worker`.
 */
export async function startWorkerProcess(
  options: WorkerStartOptions & { db?: PostgresJsDatabase; connection?: DatabaseConnection },
): Promise<{ shutdown: (signal?: string) => Promise<void> }> {
  const config = await loadAppConfig();
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

  const extensions = await loadServerExtensions(undefined, resources.decisions);
  // The app's process setup: a worker process never calls onRoutesRegistered, so anything the
  // workers need (data-plane routers, stores, runtime checks) is installed here.
  await runAppBoot(extensions.onBoot, {
    command: 'worker',
    role: 'worker',
    servesHttp: false,
    runsWorkers: true,
    config,
    db,
    logger: bootLogger({ info, warn, error: logError }),
  });
  const queues = await resolveRuntimeQueues(config, {
    onWarning: (message) => info(`Queue: ${message}`),
  });

  const metrics = createPlumbusMetrics();

  const healthPort = resolveWorkerHealthPort(options.healthPort);
  const shutdownSettings = resolveShutdownSettings();
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
  // SIGTERM: /ready answers 503, the pool stops claiming and the running step gets the
  // remaining time, then the host's onShutdown hook, queues and the database; the health
  // server closes last. Past PLUMBUS_SHUTDOWN_TIMEOUT_MS the process force-exits rather than
  // living on as a headless worker polling the shared database.
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`Graceful shutdown initiated (deadline ${shutdownSettings.timeoutMs}ms)...`);
    await runGracefulShutdown({
      settings: shutdownSettings,
      ...(signal ? { signal } : {}),
      log: { info, error: logError },
      markNotReady: () => health.markShuttingDown(),
      stopWorkers: async (deadlineAt) => {
        await workerPool.stop({ deadlineAt });
        info('Worker pool stopped');
        return workerPool.flowCycleInFlight !== true;
      },
      ...(extensions.onShutdown ? { onShutdown: extensions.onShutdown } : {}),
      closeQueues: () => queues.close(),
      closeDatabase: (timeoutSeconds) => closeDatabaseConnection(dbConnection, timeoutSeconds),
      closeHealth: () => health.stop(),
    });
    info('Worker stopped');
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logError('Second signal received during shutdown — forcing exit');
      process.exit(130);
    }
    void shutdown(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Long-running process: report every uncaught error and keep serving (process-errors.ts).
  installKeepAliveProcessHandlers({
    ...(extensions.onProcessError ? { onProcessError: extensions.onProcessError } : {}),
    ...(extensions.classifyProcessError
      ? { classifyProcessError: extensions.classifyProcessError }
      : {}),
    logError,
    logWarn: warn,
  });

  return { shutdown };
}

export function registerWorkerCommand(program: Command): void {
  const worker = program.command('worker').description('Background worker process');

  worker
    .command('start', { isDefault: true })
    .description('Start the worker pool (default)')
    .option('--health-port <port>', 'Health/metrics HTTP port (or set PLUMBUS_WORKER_HEALTH_PORT)')
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
      const config = await loadAppConfig();
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
        queueBackend: configuredDurable ? 'redis' : 'memory',
        environment: config.environment,
        queuePrefix: config.queue.prefix ?? `plumbus:${config.environment}`,
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
