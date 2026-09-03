import { createAuditService } from '../audit/service.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PromptRegistry } from '../ai/prompt-registry.js';
import type { ConsumerRegistry } from '../events/consumer-registry.js';
import type { EventRegistry } from '../events/registry.js';
import { enqueueFlowStep } from '../flows/flow-queue.js';
import type { FlowRegistry } from '../flows/registry.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import type { EntityRegistry } from '../data/registry.js';
import { resolveEncryptionKey } from '../data/field-encryption.js';
import type { PlumbusConfig } from '../types/config.js';
import type { WorkerPool } from '../worker/bootstrap.js';
import { createWorkerPool } from '../worker/bootstrap.js';
import { buildStepDeps, buildWorkerAiService, type ServerExtensions } from './bootstrap.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import type { RuntimeQueues } from './queue-factory.js';

export interface StartWorkerPoolOptions {
  config: PlumbusConfig;
  db: PostgresJsDatabase;
  queues: RuntimeQueues;
  capabilities: CapabilityRegistry;
  entities: EntityRegistry;
  events: EventRegistry;
  flows: FlowRegistry;
  consumers: ConsumerRegistry;
  promptRegistry?: PromptRegistry;
  extensions?: ServerExtensions;
  logger?: import('../types/context.js').LoggerService;
  metrics?: PlumbusMetrics;
}

/**
 * Register capability consumers and start the worker pool.
 * Used by plumbus dev, start (role=all), and plumbus worker.
 */
export async function startWorkerPool(options: StartWorkerPoolOptions): Promise<WorkerPool> {
  const {
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
    logger,
    metrics,
  } = options;

  const stepDeps = buildStepDeps(capabilities);
  const encryptionKey = resolveEncryptionKey();
  const systemAuth = {
    userId: 'system-worker',
    roles: ['system'] as string[],
    scopes: [] as string[],
    provider: 'worker',
  };
  let onMcpJobComplete:
    | ((
        jobId: string,
        result: 'completed' | 'failed',
        payload?: unknown,
        error?: unknown,
      ) => Promise<void>)
    | undefined;
  try {
    const mcp = await import('@plumbus/mcp');
    const audit = createAuditService({ db, auth: systemAuth });
    const data = entities.createDataService({ db, auth: systemAuth, audit, encryptionKey });
    onMcpJobComplete = mcp.createMcpJobCompletionSync({
      auth: systemAuth,
      data,
      audit,
      logger,
      config: config as unknown as Record<string, unknown>,
    });
  } catch {
    /* @plumbus/mcp not installed */
  }

  const aiService = buildWorkerAiService({
    config,
    db,
    promptRegistry,
    entities,
    onAICostRecorded: extensions?.onAICostRecorded,
    resolveAiOverrides: extensions?.resolveAiOverrides,
    enableStrictStructuredOutputs: extensions?.enableStrictStructuredOutputs,
  });

  const pool = createWorkerPool({
    config,
    db,
    queue: queues.events,
    jobsQueue: queues.jobs,
    flowsQueue: queues.flows,
    queuesDurable: queues.isDurable,
    redisClient: queues.redisClient,
    flowsPrefix: queues.flowsPrefix,
    refreshQueueDepths:
      metrics && queues.getDepths
        ? async () => {
            const depths = await queues.getDepths?.();
            if (!depths) return;
            metrics.queueDepth.set(depths.events, { queue: 'events' });
            metrics.queueDepth.set(depths.flows, { queue: 'flows' });
            metrics.queueDepth.set(depths.jobs, { queue: 'jobs' });
          }
        : undefined,
    onQueuesClose: () => queues.close(),
    consumers,
    flows,
    stepDeps,
    aiService,
    ...(extensions?.schedulePlanes ? { schedulePlanes: extensions.schedulePlanes } : {}),
    createDataService: (auth) => {
      const effectiveAuth = auth ?? {
        userId: 'system-flow-runner',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
      };
      return entities.createDataService({
        db,
        auth: effectiveAuth,
        bypassTenantScope: false,
        encryptionKey,
      });
    },
    eventRegistry: events,
    onFlowError: extensions?.onFlowError,
    logger,
    metrics,
    onFlowStepEnqueue: (executionId, correlationId) =>
      enqueueFlowStep(queues.flows, executionId, correlationId),
    capabilities,
    entities,
    onMcpJobComplete,
  });

  await pool.start();
  return pool;
}
