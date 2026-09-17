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
import type { AuthContext } from '../types/security.js';
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
        tenantId?: string | null,
      ) => Promise<void>)
    | undefined;
  try {
    const mcp = await import('@plumbus/mcp');
    onMcpJobComplete = async (jobId, result, payload, error, tenantId) => {
      const auth = { ...systemAuth, tenantId: tenantId ?? undefined };
      const audit = createAuditService({ db, auth });
      // Tenantless completion is scoped by trusted job ID and an explicit task-tenant check.
      const data = entities.createDataService({
        db,
        auth,
        audit,
        encryptionKey,
        bypassTenantScope: !tenantId,
      });
      // Pass the original deps-object API so rolling upgrades also work with MCP 0.5.1.
      const sync = mcp.createMcpJobCompletionSync({
        auth,
        data,
        audit,
        logger,
        config: config as unknown as Record<string, unknown>,
      });
      await sync(jobId, result, payload, error, tenantId);
    };
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
    aiProviderConcurrency: extensions?.aiProviderConcurrency,
    resolveAIProviderHeaders: extensions?.resolveAIProviderHeaders,
    onAIProviderSpan: extensions?.onAIProviderSpan,
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
    // With a host resolver the pool resolves each claimed unit's data plane and wires
    // repositories from `entities` against it; a caller-built data service would pin every
    // unit to the pool's own database, which is the one thing the resolver exists to avoid.
    ...(extensions?.dataPlaneResolver
      ? {
          dataPlaneResolver: extensions.dataPlaneResolver,
          ...(extensions.listTenantRefs ? { listTenantRefs: extensions.listTenantRefs } : {}),
          ...(extensions.untenantedDataPlane
            ? { untenantedDataPlane: extensions.untenantedDataPlane }
            : {}),
          ...(extensions.resolveTenantRef ? { resolveTenantRef: extensions.resolveTenantRef } : {}),
          ...(extensions.frameworkSchema ? { frameworkSchema: extensions.frameworkSchema } : {}),
          ...(extensions.workerDataPlane ? { unitDataPlane: extensions.workerDataPlane } : {}),
        }
      : {
          ...(extensions?.schedulePlanes ? { schedulePlanes: extensions.schedulePlanes } : {}),
          createDataService: (auth: AuthContext | undefined) => {
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
        }),
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
