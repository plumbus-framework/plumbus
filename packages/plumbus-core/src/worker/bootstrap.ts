// ── Worker Process Bootstrap ──
// Separate process that starts background workers:
// outbox dispatcher, event delivery worker, flow step executor,
// flow scheduler. Handles graceful shutdown.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createAuditService } from '../audit/service.js';
import type { ConsumerRegistry } from '../events/consumer-registry.js';
import type { DispatcherConfig } from '../events/dispatcher.js';
import { createOutboxDispatcher } from '../events/dispatcher.js';
import { createEventEmitter } from '../events/emitter.js';
import { createIdempotencyService } from '../events/idempotency.js';
import type { EventQueue } from '../events/queue.js';
import type { EventRegistry } from '../events/registry.js';
import type { WorkerConfig } from '../events/worker.js';
import { createEventWorker } from '../events/worker.js';
import { createExecutionContext } from '../execution/context-factory.js';
import type { FlowEngineConfig } from '../flows/engine.js';
import { createFlowEngine } from '../flows/engine.js';
import type { FlowRegistry } from '../flows/registry.js';
import type { SchedulerConfig } from '../flows/scheduler.js';
import { createFlowScheduler } from '../flows/scheduler.js';
import type { StepExecutorDeps } from '../flows/step-executor.js';
import { createFlowTriggerHandler } from '../flows/triggers.js';
import type { AuditService } from '../types/audit.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AIService, DataService, LoggerService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';

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
  /** Flow execution poll interval ms (default: 1000) */
  flowPollIntervalMs?: number;
  /** Whether to start the outbox dispatcher (default: true) */
  enableDispatcher?: boolean;
  /** Whether to start the event worker (default: true) */
  enableEventWorker?: boolean;
  /** Whether to start the flow scheduler (default: true) */
  enableScheduler?: boolean;
  /** Whether to run flow execution worker loop (default: true) */
  enableFlowRunner?: boolean;
  /** Optional AI service for capability steps that use AI */
  aiService?: AIService;
  /** Optional data service factory for capability steps that access data */
  createDataService?: (auth?: AuthContext) => DataService;
  /** Optional event registry for capability steps that emit events */
  eventRegistry?: EventRegistry;
  /** Called when a flow fails permanently (after retries exhausted). */
  onFlowError?: FlowEngineConfig['onFlowError'];
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
    flowPollIntervalMs = 1000,
    enableDispatcher = true,
    enableEventWorker = true,
    enableScheduler = true,
    enableFlowRunner = true,
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
    onFlowError: poolConfig.onFlowError,
    createDataService: poolConfig.createDataService
      ? (auth) => poolConfig.createDataService!(auth)
      : undefined,
  };
  const flowEngine = createFlowEngine(flowEngineConfig);

  // Auto-register flow trigger consumer for all event-triggered flows
  const triggerEventTypes = new Set<string>();
  for (const flow of flows.getAll()) {
    if (flow.trigger?.event) {
      triggerEventTypes.add(flow.trigger.event);
    }
  }
  if (triggerEventTypes.size > 0) {
    const triggerHandler = createFlowTriggerHandler({ registry: flows, engine: flowEngine });
    consumers.register({
      id: 'plumbus:flow-trigger',
      eventTypes: [...triggerEventTypes],
      handler: async (envelope) => {
        await triggerHandler.handleEvent(envelope);
      },
    });
    logger.info(`Registered flow trigger consumer for ${triggerEventTypes.size} event types`);
  }

  const schedulerConfig: SchedulerConfig = {
    db,
    registry: flows,
    engine: flowEngine,
    pollIntervalMs: schedulerPollIntervalMs,
  };
  const scheduler = enableScheduler ? createFlowScheduler(schedulerConfig) : null;
  let flowRunnerTimer: ReturnType<typeof setInterval> | null = null;
  let flowRunnerPolling = false;

  async function runFlowCycle(): Promise<void> {
    if (!enableFlowRunner || flowRunnerPolling) return;
    flowRunnerPolling = true;
    try {
      const runnable = await flowEngine.listRunnable(50);
      if (runnable.length === 0) return;

      const systemAuth = {
        userId: 'system-flow-runner',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
      };

      const systemAudit = audit ?? createAuditService({ db, auth: systemAuth });
      const dataService = poolConfig.createDataService
        ? poolConfig.createDataService()
        : ({} as DataService);
      const eventService = poolConfig.eventRegistry
        ? createEventEmitter({
            db,
            auth: systemAuth,
            registry: poolConfig.eventRegistry,
            audit: systemAudit,
          })
        : undefined;

      const baseCtx = createExecutionContext({
        auth: systemAuth,
        data: dataService,
        events: eventService,
        ai: poolConfig.aiService,
        audit: systemAudit,
        logger,
        config: poolConfig.config as unknown as Record<string, unknown>,
      });

      for (const executionId of runnable) {
        try {
          await flowEngine.runNext(executionId, baseCtx);
        } catch (err) {
          logger.error('Flow execution run failed', {
            executionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      flowRunnerPolling = false;
    }
  }

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
        logger.info('Flow scheduler started');
      }

      if (enableFlowRunner) {
        flowRunnerTimer = setInterval(() => {
          void runFlowCycle();
        }, flowPollIntervalMs);
        void runFlowCycle();
        logger.info('Flow execution runner started');
      }

      if (dispatcher) {
        dispatcher.start();
        logger.info('Outbox dispatcher started');
      }

      if (eventWorker) {
        eventWorker.start();
        logger.info('Event delivery worker started');
      }

      logger.info('Worker pool started');
    },

    async stop() {
      if (!running) return;
      logger.info('Shutting down worker pool...');

      // Stop in reverse order: new work first, then in-flight
      if (scheduler) {
        scheduler.stop();
        logger.info('Flow scheduler stopped');
      }

      if (flowRunnerTimer) {
        clearInterval(flowRunnerTimer);
        flowRunnerTimer = null;
        logger.info('Flow execution runner stopped');
      }

      if (dispatcher) {
        dispatcher.stop();
        logger.info('Outbox dispatcher stopped');
      }

      if (eventWorker) {
        eventWorker.stop();
        logger.info('Event delivery worker stopped');
      }

      await queue.close();
      logger.info('Queue closed');

      running = false;
      logger.info('Worker pool stopped');
    },

    get isRunning() {
      return running;
    },
  };
}

// ── Worker Logger ──

function createWorkerLogger(): LoggerService {
  const prefix = '[plumbus:worker]';
  return {
    debug(message, metadata) {
      console.debug(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
    info(message, metadata) {
      console.info(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
    warn(message, metadata) {
      console.warn(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
    error(message, metadata) {
      console.error(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
  };
}
