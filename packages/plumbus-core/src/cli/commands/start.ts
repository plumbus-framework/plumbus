// ── plumbus start ──
// Production server command: starts API server without watchers or dev tooling.
// Forces production environment and production-safe defaults.

import { installKeepAliveProcessHandlers } from '../../runtime/process-errors.js';
import type { Command } from 'commander';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  closeDatabaseConnection,
  resolveDatabaseConnection,
  type DatabaseConnection,
} from '../../data/connection.js';
import { PromptRegistry } from '../../ai/prompt-registry.js';
import { loadAppConfig, validateConfig } from '../../config/index.js';
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
import { bootLogger, runAppBoot } from '../../runtime/app-boot.js';
import { resolveShutdownSettings, runGracefulShutdown } from '../../runtime/graceful-shutdown.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { resolveRuntimeQueues } from '../../runtime/queue-factory.js';
import { startWorkerPool } from '../../runtime/start-worker-pool.js';
import { createPlumbusMetrics } from '../../observability/metrics.js';
import type { WorkerPool } from '../../worker/bootstrap.js';
import { info, error as logError, warn } from '../utils.js';

export interface StartOptions {
  port?: string;
  host?: string;
}

/**
 * Resolve the listen port from `--port` or `PLUMBUS_START_PORT`.
 * No default port is assumed.
 */
export function resolveStartPort(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromFlag = explicit?.trim();
  const raw = fromFlag || env.PLUMBUS_START_PORT?.trim();
  if (!raw) {
    throw new Error(
      '--port is required (or set PLUMBUS_START_PORT). No default listen port is assumed.',
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port "${raw}". Expected an integer in 1-65535 from --port or PLUMBUS_START_PORT.`,
    );
  }
  return port;
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
  shutdown: (signal?: string) => Promise<void>;
}> {
  const config = await loadAppConfig({ environment: 'production' });
  const validation = validateConfig(config);

  if (!validation.valid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`);
  }

  const port = resolveStartPort(options.port);
  const shutdownSettings = resolveShutdownSettings();
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

  const extensions = await loadServerExtensions(undefined, resources.decisions);
  // The app's process setup runs in every role, before HTTP or the worker pool exists.
  await runAppBoot(extensions.onBoot, {
    command: 'start',
    role: runtimeRole,
    servesHttp: shouldStartApiServer(runtimeRole),
    runsWorkers: shouldStartWorkerPool(runtimeRole),
    config,
    db,
    logger: bootLogger({ info, warn, error: logError }),
  });
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
      decisions: extensions.decisions,
      enableStrictStructuredOutputs: extensions.enableStrictStructuredOutputs,
      credentials: extensions.credentials,
      authenticationRuntime: extensions.authenticationRuntime,
      ...(extensions.bodyLimit != null && { bodyLimit: extensions.bodyLimit }),
      ...(extensions.dataPlaneResolver && { dataPlaneResolver: extensions.dataPlaneResolver }),
      ...(extensions.untenantedDataPlane && {
        untenantedDataPlane: extensions.untenantedDataPlane,
      }),
      ...(extensions.resolveTenantRef && { resolveTenantRef: extensions.resolveTenantRef }),
      ...(extensions.requestDataPlane && { requestDataPlane: extensions.requestDataPlane }),
      ...(extensions.idempotencyStore && { idempotencyStore: extensions.idempotencyStore }),
      jobQueue: jobQueueNeeded ? queues.jobs : undefined,
      checkQueueReadiness: queues.isDurable ? queues.pingRedis : undefined,
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

  // SIGTERM: /ready answers 503 at once, HTTP drains (after PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS),
  // then the workers stop claiming and the running step gets the remaining time, then the
  // host's onShutdown hook, queues and the database. In-flight work can hang (a wedged
  // provider socket inside a step): past PLUMBUS_SHUTDOWN_TIMEOUT_MS the process force-exits
  // instead of living on as a headless worker polling the shared database.
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`Graceful shutdown initiated (deadline ${shutdownSettings.timeoutMs}ms)...`);
    const httpServer = server;
    const pool = workerPool;
    await runGracefulShutdown({
      settings: shutdownSettings,
      ...(signal ? { signal } : {}),
      log: { info, error: logError },
      ...(httpServer
        ? {
            markNotReady: () => httpServer.markShuttingDown?.(),
            closeHttp: () => httpServer.stop(),
            forceCloseHttp: () => httpServer.app.server?.closeAllConnections?.(),
          }
        : {}),
      ...(pool
        ? {
            stopWorkers: async (deadlineAt: number) => {
              await pool.stop({ deadlineAt });
              info('Worker pool stopped');
              return pool.flowCycleInFlight !== true;
            },
          }
        : {}),
      ...(extensions.onShutdown ? { onShutdown: extensions.onShutdown } : {}),
      closeQueues: () => queues.close(),
      closeDatabase: (timeoutSeconds) => closeDatabaseConnection(dbConnection, timeoutSeconds),
    });
    info('Server stopped');
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
    .option('-p, --port <port>', 'Server port (or set PLUMBUS_START_PORT)')
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
