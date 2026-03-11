// ── Worker Process Bootstrap ──
// Separate process that starts background workers:
// outbox dispatcher, event delivery worker, flow step executor,
// flow scheduler. Handles graceful shutdown.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ConsumerRegistry } from "../events/consumer-registry.js";
import type { DispatcherConfig } from "../events/dispatcher.js";
import { createOutboxDispatcher } from "../events/dispatcher.js";
import { createIdempotencyService } from "../events/idempotency.js";
import type { EventQueue } from "../events/queue.js";
import type { WorkerConfig } from "../events/worker.js";
import { createEventWorker } from "../events/worker.js";
import type { FlowEngineConfig } from "../flows/engine.js";
import { createFlowEngine } from "../flows/engine.js";
import { FlowRegistry } from "../flows/registry.js";
import type { SchedulerConfig } from "../flows/scheduler.js";
import { createFlowScheduler } from "../flows/scheduler.js";
import type { StepExecutorDeps } from "../flows/step-executor.js";
import type { AuditService } from "../types/audit.js";
import type { PlumbusConfig } from "../types/config.js";
import type { LoggerService } from "../types/context.js";

// ── Worker Pool Config ──

export interface WorkerPoolConfig {
  /** Plumbus framework config */
  config: PlumbusConfig;
  /** Database connection */
  db: PostgresJsDatabase;
  /** Event queue */
  queue: EventQueue;
  /** Consumer registry */
  consumers: ConsumerRegistry;
  /** Flow registry */
  flows: FlowRegistry;
  /** Step executor dependencies (capability invoker + condition evaluator) */
  stepDeps: StepExecutorDeps;
  /** Optional audit service for flow execution audit trail */
  audit?: AuditService;
  /** Optional logger */
  logger?: LoggerService;
  /** Outbox poll interval ms (default: 1000) */
  outboxPollIntervalMs?: number;
  /** Scheduler poll interval ms (default: 60000) */
  schedulerPollIntervalMs?: number;
  /** Whether to start the outbox dispatcher (default: true) */
  enableDispatcher?: boolean;
  /** Whether to start the event worker (default: true) */
  enableEventWorker?: boolean;
  /** Whether to start the flow scheduler (default: true) */
  enableScheduler?: boolean;
}

// ── Worker Pool Instance ──

export interface WorkerPool {
  /** Start all enabled workers */
  start(): Promise<void>;
  /** Graceful shutdown — stops all workers */
  stop(): Promise<void>;
  /** Whether any worker is running */
  readonly isRunning: boolean;
}

/** Create and configure a worker pool with all background processes */
export function createWorkerPool(poolConfig: WorkerPoolConfig): WorkerPool {
  const {
    db,
    queue,
    consumers,
    flows,
    stepDeps,
    audit,
    outboxPollIntervalMs = 1000,
    schedulerPollIntervalMs = 60_000,
    enableDispatcher = true,
    enableEventWorker = true,
    enableScheduler = true,
  } = poolConfig;

  const logger = poolConfig.logger ?? createWorkerLogger();

  // Idempotency service for event worker
  const idempotency = createIdempotencyService(db);

  // Outbox dispatcher
  const dispatcherConfig: DispatcherConfig = {
    db,
    queue,
    pollIntervalMs: outboxPollIntervalMs,
  };
  const dispatcher = enableDispatcher ? createOutboxDispatcher(dispatcherConfig) : null;

  // Event delivery worker
  const eventWorkerConfig: WorkerConfig = {
    db,
    queue,
    consumers,
    idempotency,
  };
  const eventWorker = enableEventWorker ? createEventWorker(eventWorkerConfig) : null;

  // Flow engine + scheduler
  const flowEngineConfig: FlowEngineConfig = {
    db,
    registry: flows,
    stepDeps,
    audit,
    queue,
  };
  const flowEngine = createFlowEngine(flowEngineConfig);
  const schedulerConfig: SchedulerConfig = {
    db,
    registry: flows,
    engine: flowEngine,
    pollIntervalMs: schedulerPollIntervalMs,
  };
  const scheduler = enableScheduler ? createFlowScheduler(schedulerConfig) : null;

  let running = false;

  return {
    async start() {
      if (running) return;
      running = true;

      // Sync flow schedules to DB
      if (scheduler) {
        const synced = await scheduler.syncSchedules();
        logger.info(`Synced ${synced} flow schedules`);
        scheduler.start();
        logger.info("Flow scheduler started");
      }

      if (dispatcher) {
        dispatcher.start();
        logger.info("Outbox dispatcher started");
      }

      if (eventWorker) {
        eventWorker.start();
        logger.info("Event delivery worker started");
      }

      logger.info("Worker pool started");
    },

    async stop() {
      if (!running) return;
      logger.info("Shutting down worker pool...");

      // Stop in reverse order: new work first, then in-flight
      if (scheduler) {
        scheduler.stop();
        logger.info("Flow scheduler stopped");
      }

      if (dispatcher) {
        dispatcher.stop();
        logger.info("Outbox dispatcher stopped");
      }

      if (eventWorker) {
        eventWorker.stop();
        logger.info("Event delivery worker stopped");
      }

      await queue.close();
      logger.info("Queue closed");

      running = false;
      logger.info("Worker pool stopped");
    },

    get isRunning() {
      return running;
    },
  };
}

// ── Worker Logger ──

function createWorkerLogger(): LoggerService {
  const prefix = "[plumbus:worker]";
  return {
    info(message, metadata) {
      console.info(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : "");
    },
    warn(message, metadata) {
      console.warn(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : "");
    },
    error(message, metadata) {
      console.error(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : "");
    },
  };
}
