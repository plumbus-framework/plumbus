// ── Capability Consumer Registration ──
// Auto-wires eventHandler and job capabilities into the ConsumerRegistry.

import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveEncryptionKey } from '../data/field-encryption.js';
import type { ConsumerRegistry } from '../events/consumer-registry.js';
import type { EventRegistry } from '../events/registry.js';
import { outboxTable } from '../events/outbox.js';
import { TrustedReplayActor, type EventEnvelope } from '../types/event.js';
import { CapabilityKind } from '../types/enums.js';
import { buildCapabilityRuntimeDeps } from '../execution/capability-invocation.js';
import { wireContextDependencies } from '../execution/context-deps.js';
import { executeCapability } from '../execution/capability-executor.js';
import { evaluateAccess } from '../execution/authorization.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import { createExecutionContext } from '../execution/context-factory.js';
import { createFlowService } from '../flows/flow-service.js';
import type { createFlowEngine } from '../flows/engine.js';
import type { FlowRegistry } from '../flows/registry.js';
import { createJobService, JobClaimResult } from '../jobs/service.js';
import { jobEventType, type JobQueuePayload } from '../jobs/types.js';
import type { EntityRegistry } from '../data/registry.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AIService, LoggerService } from '../types/context.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import type { AuthContext } from '../types/security.js';

export interface RegisterCapabilityConsumersOptions {
  capabilities: CapabilityRegistry;
  consumers: ConsumerRegistry;
  events: EventRegistry;
  entities: EntityRegistry;
  db: PostgresJsDatabase;
  config: PlumbusConfig;
  flowEngine?: ReturnType<typeof createFlowEngine>;
  /** Flow registry — enables `ctx.flows.describe()` for flow-tool binding on chat surfaces. */
  flowRegistry?: FlowRegistry;
  aiService?: AIService;
  logger?: LoggerService;
  metrics?: PlumbusMetrics;
  /** Called when MCP task rows need status sync (optional @plumbus/mcp integration). */
  onMcpJobComplete?: (
    jobId: string,
    result: 'completed' | 'failed',
    payload?: unknown,
    error?: unknown,
    tenantId?: string | null,
  ) => Promise<void>;
}

function eventWorkerAuth(
  cap: { access?: { serviceAccounts?: string[] } },
  envelope: EventEnvelope,
  tenantId?: string | null,
): AuthContext {
  const serviceAccount = cap.access?.serviceAccounts?.[0] ?? 'event-worker';
  return {
    userId: serviceAccount,
    roles: ['system'],
    scopes: [],
    provider: 'event-worker',
    tenantId: tenantId ?? envelope.tenantId,
  };
}

const TRUSTED_REPLAY_ACTORS = new Set<string>([
  TrustedReplayActor.OpsRetry,
  TrustedReplayActor.OutboxReplay,
]);

function isTrustedReplay(envelope: EventEnvelope): boolean {
  return TRUSTED_REPLAY_ACTORS.has(envelope.actor);
}

function tenantFromTrustedReplay(envelope: EventEnvelope): string | null | undefined {
  if (envelope.tenantId != null) {
    return envelope.tenantId;
  }
  const metaTenant = envelope.metadata?.tenantId;
  if (typeof metaTenant === 'string') {
    return metaTenant;
  }
  return undefined;
}

async function resolveEventHandlerTenantId(
  db: PostgresJsDatabase,
  envelope: EventEnvelope,
  logger?: LoggerService,
): Promise<string | null | undefined> {
  const rows = await db
    .select({ tenantId: outboxTable.tenantId, eventType: outboxTable.eventType })
    .from(outboxTable)
    .where(eq(outboxTable.id, envelope.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    if (isTrustedReplay(envelope)) {
      const tenantId = tenantFromTrustedReplay(envelope);
      logger?.info?.('Trusted replay delivery without outbox row', {
        eventId: envelope.id,
        eventType: envelope.eventType,
        actor: envelope.actor,
        tenantId,
      });
      return tenantId;
    }
    throw new Error(
      `Event handler rejected: no outbox row for event "${envelope.id}" — possible forged queue message. ` +
        'Redis is a trust boundary; replay via plumbus events replay/dead-letter retry only.',
    );
  }
  if (row.eventType !== envelope.eventType) {
    throw new Error(
      `Event envelope type mismatch for "${envelope.id}": queue=${envelope.eventType} outbox=${row.eventType}`,
    );
  }
  if (row.tenantId != null && envelope.tenantId != null && row.tenantId !== envelope.tenantId) {
    throw new Error(
      `Event envelope tenant mismatch for "${envelope.id}": queue=${envelope.tenantId} outbox=${row.tenantId}`,
    );
  }
  return row.tenantId ?? envelope.tenantId;
}

function buildConsumerContext(
  opts: RegisterCapabilityConsumersOptions,
  auth: AuthContext,
  eventMeta?: { correlationId?: string; causationId?: string },
): ReturnType<typeof createExecutionContext> {
  const flows = opts.flowEngine
    ? createFlowService(opts.flowEngine, auth, opts.flowRegistry)
    : undefined;
  const capRuntime = buildCapabilityRuntimeDeps(opts.capabilities);
  const encryptionKey = resolveEncryptionKey();

  const deps = wireContextDependencies(
    {
      db: opts.db,
      auth,
      entities: opts.entities,
      events: opts.events,
      correlationId: eventMeta?.correlationId,
      getCausationId: () => eventMeta?.causationId,
      encryptionKey,
    },
    {
      flows,
      ai: opts.aiService,
      logger: opts.logger,
      config: opts.config as unknown as Record<string, unknown>,
      correlationId: eventMeta?.correlationId,
      ...capRuntime,
    },
  );

  return createExecutionContext(deps);
}

/**
 * Register eventHandler (with trigger.event) and job capabilities as queue consumers.
 * Skips handlers whose consumer id is already registered manually.
 */
export function registerCapabilityConsumers(opts: RegisterCapabilityConsumersOptions): void {
  const jobs = createJobService(opts.db);

  for (const cap of opts.capabilities.getAll()) {
    if (cap.kind === CapabilityKind.EventHandler && cap.trigger?.event) {
      if (opts.consumers.getById(cap.name)) {
        opts.logger?.debug?.(
          `Skipping auto-registration for "${cap.name}" — manual consumer exists`,
        );
        continue;
      }

      opts.consumers.register({
        id: cap.name,
        eventTypes: [cap.trigger.event],
        versionConstraint: cap.trigger.versionConstraint,
        handler: async (envelope) => {
          const tenantId = await resolveEventHandlerTenantId(opts.db, envelope, opts.logger);
          const auth = eventWorkerAuth(cap, envelope, tenantId);
          const authz = evaluateAccess(cap.access, auth);
          if (!authz.allowed) {
            throw new Error(authz.reason ?? 'Event handler access denied');
          }
          const parsed = cap.input.safeParse(envelope.payload);
          if (!parsed.success) {
            throw new Error(`Event payload validation failed for handler "${cap.name}"`);
          }
          const ctx = buildConsumerContext(opts, auth, {
            correlationId: envelope.correlationId,
            causationId: envelope.id,
          });
          const started = Date.now();
          const result = await executeCapability(cap, ctx, parsed.data);
          opts.metrics?.capabilityDuration.observe(Date.now() - started, {
            capability: cap.name,
            kind: 'eventHandler',
          });
          if (!result.success) {
            opts.metrics?.eventFailed.inc({ consumer: cap.name });
            throw new Error(result.error.message);
          }
          opts.metrics?.eventDelivered.inc({ consumer: cap.name });
        },
      });
    }

    if (cap.kind === CapabilityKind.Job) {
      const eventType = jobEventType(cap.domain, cap.name);
      const consumerId = `job:${cap.domain}:${cap.name}`;
      if (opts.consumers.getById(consumerId)) {
        continue;
      }

      opts.consumers.register({
        id: consumerId,
        eventTypes: [eventType],
        handler: async (envelope) => {
          const payload = envelope.payload as JobQueuePayload;
          const started = Date.now();

          const record = await jobs.getById(payload.jobExecutionId);
          if (!record) {
            throw new Error(`Job execution "${payload.jobExecutionId}" not found`);
          }
          if (
            record.capabilityDomain !== cap.domain ||
            record.capabilityName !== cap.name ||
            payload.capability.domain !== cap.domain ||
            payload.capability.name !== cap.name
          ) {
            await jobs.markFailed(payload.jobExecutionId, {
              code: 'capability_mismatch',
              message: 'Job capability mismatch at dequeue',
            });
            throw new Error('Job capability mismatch at dequeue');
          }

          const auth = record.authSnapshotJson;
          if (!auth) {
            await jobs.markFailed(payload.jobExecutionId, {
              code: 'missing_auth_snapshot',
              message: 'Job auth snapshot missing at dequeue',
            });
            throw new Error('Job auth snapshot missing at dequeue');
          }

          const authz = evaluateAccess(cap.access, auth);
          if (!authz.allowed) {
            await jobs.markFailed(payload.jobExecutionId, {
              code: 'forbidden',
              message: authz.reason ?? 'Job access denied at dequeue',
            });
            throw new Error(authz.reason ?? 'Job access denied');
          }

          const staleAfterMs = (opts.config.queue?.visibilityTimeoutSec ?? 30) * 1000;
          const claimResult = await jobs.tryClaimForExecution(payload.jobExecutionId, staleAfterMs);
          if (claimResult === JobClaimResult.Terminal) {
            opts.logger?.debug?.('Job already terminal — acknowledging duplicate delivery', {
              jobExecutionId: payload.jobExecutionId,
            });
            return;
          }
          if (claimResult === JobClaimResult.Retry) {
            throw new Error(`Job "${payload.jobExecutionId}" claim failed — will retry`);
          }

          const ctx = buildConsumerContext(opts, auth, {
            correlationId: envelope.correlationId,
            causationId: envelope.id,
          });
          const jobInput = record.inputJson ?? payload.input;
          const parsed = cap.input.safeParse(jobInput);
          if (!parsed.success) {
            await jobs.markFailed(payload.jobExecutionId, {
              code: 'validation',
              message: 'Invalid job input at dequeue',
            });
            throw new Error('Invalid job input');
          }

          const result = await executeCapability(cap, ctx, parsed.data);
          opts.metrics?.capabilityDuration.observe(Date.now() - started, {
            capability: cap.name,
            kind: 'job',
          });
          if (result.success) {
            await jobs.markCompleted(payload.jobExecutionId, result.data);
            await opts.onMcpJobComplete?.(
              payload.jobExecutionId,
              'completed',
              result.data,
              undefined,
              record.tenantId,
            );
            opts.metrics?.eventDelivered.inc({ consumer: consumerId });
          } else {
            await jobs.markFailed(payload.jobExecutionId, {
              code: result.error.code,
              message: result.error.message,
            });
            await opts.onMcpJobComplete?.(
              payload.jobExecutionId,
              'failed',
              undefined,
              result.error,
              record.tenantId,
            );
            opts.metrics?.eventFailed.inc({ consumer: consumerId });
            throw new Error(result.error.message);
          }
        },
      });
    }
  }
}
