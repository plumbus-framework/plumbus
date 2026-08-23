// ── Shared Runtime Bootstrap ──
// Deduplicated wiring for plumbus dev, start, and worker commands.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AIServiceConfig } from '../ai/ai-service.js';
import { createAIService, singleProviderConfig } from '../ai/ai-service.js';
import { buildAISecurityConfig } from '../ai/security.js';
import type { AICostRecord } from '../ai/cost-tracker.js';
import { createCostTracker } from '../ai/cost-tracker.js';
import type { PromptRegistry } from '../ai/prompt-registry.js';
import { createProviderAdapter } from '../ai/provider.js';
import type { DiscoveredResources } from '../cli/discover.js';
import { discoverResources } from '../cli/discover.js';
import type { EntityRegistry } from '../data/registry.js';
import { CapabilityKind } from '../types/enums.js';
import { executeCapability } from '../execution/capability-executor.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import { getCanonicalCapabilityName } from '../execution/canonical-name.js';
import {
  buildDependencyViolationMessage,
  type DependencyViolationMetadata,
} from '../execution/capability-invocation.js';
import { evaluateFlowCondition } from '../flows/evaluate-condition.js';
import type { StepExecutorDeps } from '../flows/step-executor.js';
import type { ServerConfig } from '../server/bootstrap.js';
import { wrapAIServiceWithDynamicOverrides } from '../server/bootstrap.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AIService, AICostContext } from '../types/context.js';
import type { WorkerPoolConfig } from '../worker/bootstrap.js';

/** Runtime process role — controls which subsystems start in this process. */
export const RuntimeRole = {
  All: 'all',
  Api: 'api',
  Worker: 'worker',
} as const;

export type RuntimeRole = (typeof RuntimeRole)[keyof typeof RuntimeRole];

export type RuntimeCommand = 'dev' | 'start' | 'worker';

/** Discover app resources from app/ directories. */
export async function discoverRuntimeResources(): Promise<DiscoveredResources> {
  return discoverResources();
}

/**
 * Resolve which runtime subsystems run in this process.
 * Defaults preserve backward compatibility: dev and start run API + workers together.
 */
export function resolveRuntimeRole(
  command: RuntimeCommand,
  env: Record<string, string | undefined> = process.env,
): RuntimeRole {
  const explicit = env.PLUMBUS_RUNTIME_ROLE?.toLowerCase();
  if (explicit === 'api' || explicit === 'worker' || explicit === 'all') {
    return explicit;
  }
  if (command === 'worker') {
    return RuntimeRole.Worker;
  }
  return RuntimeRole.All;
}

/** Whether this process should start the background worker pool. */
export function shouldStartWorkerPool(role: RuntimeRole): boolean {
  return role !== RuntimeRole.Api;
}

/** Whether this process should start the HTTP API server. */
export function shouldStartApiServer(role: RuntimeRole): boolean {
  return role !== RuntimeRole.Worker;
}

/**
 * Returns true when any background/async work may exist and the worker pool
 * should run (when role allows).
 */
export function needsWorkerPool(resources: DiscoveredResources): boolean {
  if (resources.events.length > 0) {
    return true;
  }
  for (const flow of resources.flows) {
    if (flow.trigger?.event || flow.schedule) {
      return true;
    }
  }
  for (const cap of resources.capabilities) {
    if (cap.kind === CapabilityKind.EventHandler || cap.kind === CapabilityKind.Job) {
      return true;
    }
  }
  return false;
}

/** True when the API process must publish async jobs (split deploy with role=api). */
export function needsJobQueuePublish(resources: DiscoveredResources): boolean {
  return resources.capabilities.some((cap) => cap.kind === CapabilityKind.Job);
}

/** Build step executor dependencies shared by worker pool and flow engine. */
export function buildStepDeps(capabilities: CapabilityRegistry): StepExecutorDeps {
  return {
    executeCapability: async (capabilityName, ctx, input) => {
      const capability = capabilities.get(capabilityName);
      if (!capability) {
        return {
          success: false,
          error: { code: 'not_found', message: `Capability "${capabilityName}" not found` },
        };
      }
      if (capability.kind === CapabilityKind.Job) {
        const metadata: DependencyViolationMetadata = {
          target: getCanonicalCapabilityName(capability),
          reason: 'unsupportedTargetKind',
          capabilityStack: ctx.__runtime?.capabilityStack ?? [],
        };
        const message = buildDependencyViolationMessage(metadata);
        const error = ctx.errors.dependencyViolation(message, { ...metadata });
        return { success: false, error };
      }
      return executeCapability(capability, ctx, input);
    },
    evaluateCondition: (expression, state) => evaluateFlowCondition(expression, state),
  };
}

export interface BuildWorkerAiServiceOptions {
  config: PlumbusConfig;
  db: PostgresJsDatabase;
  promptRegistry?: PromptRegistry;
  entities?: EntityRegistry;
  onAICostRecorded?: ServerConfig['onAICostRecorded'];
  resolveAiOverrides?: ServerConfig['resolveAiOverrides'];
  enableStrictStructuredOutputs?: ServerConfig['enableStrictStructuredOutputs'];
}

/** Build AI service for worker/flow execution (deduplicated from dev/start). */
export function buildWorkerAiService(options: BuildWorkerAiServiceOptions): AIService | undefined {
  const {
    config,
    db,
    promptRegistry,
    entities,
    onAICostRecorded,
    resolveAiOverrides,
    enableStrictStructuredOutputs,
  } = options;

  const workerOnAICostRecorded = onAICostRecorded
    ? (record: AICostRecord, costContext: AICostContext | undefined) =>
        onAICostRecorded(record, costContext, db)
    : undefined;

  if (config.aiProviders) {
    const providerAdapters: Record<string, ReturnType<typeof createProviderAdapter>> = {};
    for (const [name, provCfg] of Object.entries(config.aiProviders.providers)) {
      providerAdapters[name] = createProviderAdapter(name, provCfg);
    }
    const costTracker = createCostTracker({
      maxTokensPerRequest: Object.values(config.aiProviders.providers)[0]?.maxTokensPerRequest,
      dailyCostLimit: Object.values(config.aiProviders.providers)[0]?.dailyCostLimit,
    });
    const workerAiServiceConfig: AIServiceConfig = {
      providers: providerAdapters,
      defaultProvider: config.aiProviders.defaultProvider,
      defaultModel: config.aiProviders.defaultModel,
      costTracker,
      promptRegistry,
      onAICostRecorded: workerOnAICostRecorded,
      enableStrictStructuredOutputs,
      security: buildAISecurityConfig(
        entities?.getAllEntities() ?? [],
        config.aiProviders.security,
      ),
    };
    let aiService = createAIService(workerAiServiceConfig);
    if (resolveAiOverrides) {
      aiService = wrapAIServiceWithDynamicOverrides(
        aiService,
        workerAiServiceConfig,
        resolveAiOverrides,
        db,
      );
    }
    return aiService;
  }

  if (config.ai) {
    const adapter = createProviderAdapter(config.ai.provider, config.ai);
    const costTracker = createCostTracker({
      maxTokensPerRequest: config.ai.maxTokensPerRequest,
      dailyCostLimit: config.ai.dailyCostLimit,
    });
    return createAIService(
      singleProviderConfig(adapter, {
        costTracker,
        promptRegistry,
        onAICostRecorded: workerOnAICostRecorded,
        enableStrictStructuredOutputs,
      }),
    );
  }

  return undefined;
}

export type ServerExtensions = Pick<
  ServerConfig,
  | 'onRoutesRegistered'
  | 'resolveAiOverrides'
  | 'onCapabilityError'
  | 'onProcessError'
  | 'onAICostRecorded'
  | 'enableStrictStructuredOutputs'
  | 'credentials'
> & {
  onFlowError?: WorkerPoolConfig['onFlowError'];
};
