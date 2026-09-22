// ── plumbus start ──
// Production server command: starts API server without watchers or dev tooling.
// Forces production environment and production-safe defaults.

import type { Command } from 'commander';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  closeDatabaseConnection,
  resolveDatabaseConnection,
  type DatabaseConnection,
} from '../../data/connection.js';
import { PromptRegistry } from '../../ai/prompt-registry.js';
import { loadConfig, validateConfig } from '../../config/loader.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { PlumbusServer } from '../../server/bootstrap.js';
import { createServer } from '../../server/bootstrap.js';
import {
  discoverRuntimeResources,
  needsJobQueuePublish,
  needsWorkerPool,
  resolveRuntimeRole,
  shouldStartApiServer,
  shouldStartWorkerPool,
} from '../../runtime/bootstrap.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { resolveRuntimeQueues } from '../../runtime/queue-factory.js';
import { startWorkerPool } from '../../runtime/start-worker-pool.js';
import { createPlumbusMetrics } from '../../observability/metrics.js';
import type { WorkerPool } from '../../worker/bootstrap.js';
import { logHookError } from '../../errors/hook-log.js';
import { info, error as logError } from '../utils.js';

export interface StartOptions {
  port?: string;
  host?: string;
}

/**
 * Start the production server.
 * Discovers resources from app/, populates registries, connects to DB,
 * and starts the Fastify server with production defaults.
 *
 * Default runtime role is `all` (API + workers in-process) for backward compatibility.
 * Set PLUMBUS_RUNTIME_ROLE=api for API-only; run `plumbus worker` separately.
 */
export async function startProductionServer(
  options: StartOptions & { db?: PostgresJsDatabase; connection?: DatabaseConnection },
): Promise<{
  server?: PlumbusServer;
  shutdown: () => Promise<void>;
}> {
  const config = loadConfig({ environment: 'production' });
  const validation = validateConfig(config);

  if (!validation.valid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`);
  }

  const port = parseInt(options.port ?? '3000', 10);
  const host = options.host ?? '0.0.0.0';
  const serverUrl = `http://${host}:${port}`;
  const runtimeRole = resolveRuntimeRole('start');

  info('Plumbus Production Server');
  info(`Server URL: ${serverUrl}`);
  info(`Runtime role: ${runtimeRole}`);

  info('Discovering resources from app/ ...');
  const resources = await discoverRuntimeResources();
  info(
    `Found ${resources.capabilities.length} capabilities, ${resources.entities.length} entities, ` +
      `${resources.flows.length} flows, ${resources.events.length} events, ${resources.prompts.length} prompts`,
  );

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

  let dbConnection: DatabaseConnection;
  try {
    dbConnection = await resolveDatabaseConnection(config.database, options);
    if (dbConnection.sql) {
      info('Database connected');
    }
  } catch (err) {
    throw new Error(
      `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const db = dbConnection.db;

  const extensions = await loadServerExtensions();
  const queues = await resolveRuntimeQueues(config, {
    onWarning: (message) => info(`Queue: ${message}`),
  });
  const workerNeeded = needsWorkerPool(resources) && shouldStartWorkerPool(runtimeRole);
  const jobQueueNeeded = shouldStartApiServer(runtimeRole) && needsJobQueuePublish(resources);
  const metrics = workerNeeded ? createPlumbusMetrics() : undefined;

  let server: PlumbusServer | undefined;
  if (shouldStartApiServer(runtimeRole)) {
    server = createServer({
      config,
      db: db,
      capabilities,
      entities,
      events,
      consumers,
      flows,
      translations: resources.translations,
      promptRegistry,
      host,
      port,
      onRoutesRegistered: extensions.onRoutesRegistered,
      resolveAiOverrides: extensions.resolveAiOverrides,
      onCapabilityError: extensions.onCapabilityError,
      onProcessError: extensions.onProcessError,
      onAICostRecorded: extensions.onAICostRecorded,
      enableStrictStructuredOutputs: extensions.enableStrictStructuredOutputs,
      jobQueue: jobQueueNeeded ? queues.jobs : undefined,
      metrics,
      ...(process.env.TRUST_PROXY && {
        trustProxy: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY,
      }),
    });
  }

  let shuttingDown = false;
  let workerPool: WorkerPool | undefined;

  if (workerNeeded) {
    workerPool = await startWorkerPool({
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
  }

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('Graceful shutdown initiated...');
    // In-flight work can hang indefinitely (e.g. a wedged provider socket
    // inside a flow step keeps workerPool.stop() waiting forever). Never let
    // that turn a termination signal into a headless zombie worker that
    // keeps polling the shared DB: force-exit after a hard deadline.
    const deadline = setTimeout(() => {
      logError('Graceful shutdown timed out after 10s — forcing exit');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    if (workerPool) {
      await workerPool.stop();
      info('Worker pool stopped');
    }
    if (server) {
      await server.stop();
    }
    await queues.close();
    await closeDatabaseConnection(dbConnection);
    clearTimeout(deadline);
    info('Server stopped');
  };

  const onSignal = () => {
    if (shuttingDown) {
      logError('Second signal received during shutdown — forcing exit');
      process.exit(130);
    }
    void shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (extensions.onProcessError) {
    const errorHook = extensions.onProcessError;
    process.on('uncaughtException', (err) => {
      logError(`Uncaught exception: ${err.message}`);
      Promise.resolve(
        errorHook({
          source: 'uncaughtException',
          message: err.message,
          stack: err.stack,
        }),
      ).catch((hookErr) => {
        logHookError('onProcessError', hookErr);
      });
    });
    process.on('unhandledRejection', (reason) => {
      const message =
        reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection');
      const stack = reason instanceof Error ? reason.stack : undefined;
      logError(`Unhandled rejection: ${message}`);
      Promise.resolve(
        errorHook({
          source: 'unhandledRejection',
          message,
          stack,
        }),
      ).catch((hookErr) => {
        logHookError('onProcessError', hookErr);
      });
    });
    info('Process-level error handlers registered');
  }

  if (server) {
    const address = await server.start();
    info(`Server listening on ${address}`);
    info(`Health: ${serverUrl}/health`);
    info(`Ready: ${serverUrl}/ready`);
  } else {
    info('API server disabled (worker-only role)');
  }

  return { server, shutdown };
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start production server')
    .option('-p, --port <port>', 'Server port', '3000')
    .option('-H, --host <host>', 'Server host', '0.0.0.0')
    .action(async (opts: StartOptions) => {
      try {
        await startProductionServer(opts);
      } catch (err) {
        logError(
          `Failed to start production server: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
