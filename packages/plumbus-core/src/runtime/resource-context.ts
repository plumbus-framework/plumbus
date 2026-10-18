// Shared governed resource context for MCP and scoped voice workers.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PromptRegistry } from '../ai/prompt-registry.js';
import type { RouteGeneratorConfig } from '../api/route-generator.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../data/connection.js';
import type { EntityDefinition } from '../types/entity.js';
import { collectMaskedFieldsFromEntities } from '../data/mask-fields.js';
import { resolveEncryptionKey } from '../data/field-encryption.js';
import { EntityRegistry } from '../data/registry.js';
import { EventRegistry } from '../events/registry.js';
import { CapabilityRegistry } from '../execution/capability-registry.js';
import { buildCapabilityRuntimeDeps } from '../execution/capability-invocation.js';
import { wireContextDependencies } from '../execution/context-deps.js';
import {
  createInvocationEmitScope,
  resolveInvocationCausationId,
} from '../execution/invocation-emit-scope.js';
import { createFlowEngine } from '../flows/engine.js';
import { createFlowService } from '../flows/flow-service.js';
import { FlowRegistry } from '../flows/registry.js';
import { createTranslationService, TranslationRegistry } from '../translations/index.js';
import { createStructuredLogger, withLogMasking } from '../observability/metrics.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AuthContext } from '../types/security.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import { buildWorkerAiService } from '../runtime/bootstrap.js';
import { resolveRuntimeQueues } from '../runtime/queue-factory.js';
import type { EventQueue } from '../events/queue.js';

import type { DiscoveredResources } from '../cli/discover.js';
import type { ServerExtensions } from './bootstrap.js';
import type { AuthAdapter } from '../auth/index.js';
export interface ResourceContext {
  config: PlumbusConfig;
  db: PostgresJsDatabase;
  capabilities: CapabilityRegistry;
  routeConfig: RouteGeneratorConfig;
  jobQueue?: EventQueue;
  closeQueues: () => Promise<void>;
  closeDb: () => Promise<void>;
}

export async function buildResourceContext(options: {
  config: PlumbusConfig;
  resources: DiscoveredResources;
  extensions: ServerExtensions;
  authAdapter: AuthAdapter;
  component: string;
  openQueues: boolean;
  enableFlows: boolean;
  securityEntities?: EntityDefinition[];
}): Promise<ResourceContext> {
  const { config, resources, extensions, authAdapter, component } = options;
  const capabilities = new CapabilityRegistry();
  capabilities.registerAll(resources.capabilities);

  const promptRegistry = new PromptRegistry();
  for (const prompt of resources.prompts) {
    promptRegistry.register(prompt);
  }

  const entities = new EntityRegistry();
  entities.registerAll(resources.entities);

  const events = new EventRegistry();
  events.registerAll(resources.events);

  const flows = new FlowRegistry();
  flows.registerAll(resources.flows);

  const dbConnection = await resolveDatabaseConnection(config.database, {});
  const db = dbConnection.db;

  let queues: Awaited<ReturnType<typeof resolveRuntimeQueues>> | undefined;
  try {
    queues = options.openQueues ? await resolveRuntimeQueues(config) : undefined;

    const translationRegistry = new TranslationRegistry();
    translationRegistry.registerAll(resources.translations ?? []);
    const defaultLocale = resources.translations?.[0]?.defaultLocale ?? 'en';
    const supportedLocales = translationRegistry.getSupportedLocales();
    const resolvedSupportedLocales =
      supportedLocales.length > 0 ? supportedLocales : [defaultLocale];
    const maskKeys = collectMaskedFieldsFromEntities([
      ...resources.entities,
      ...(options.securityEntities ?? []),
    ]);
    const encryptionKey = resolveEncryptionKey();

    const aiService = buildWorkerAiService({
      config,
      db,
      promptRegistry,
      entities,
      securityEntities: options.securityEntities,
      decisions: extensions.decisions,
      onAICostRecorded: extensions.onAICostRecorded,
      resolveAiOverrides: extensions.resolveAiOverrides,
      enableStrictStructuredOutputs: extensions.enableStrictStructuredOutputs,
    });

    const requestFlowEngine = options.enableFlows
      ? createFlowEngine({
          db,
          registry: flows,
          stepDeps: {
            async executeCapability() {
              return {
                success: false,
                error: 'Flow execution is worker-owned',
              };
            },
            evaluateCondition() {
              return false;
            },
          },
        })
      : undefined;

    const routeConfig: RouteGeneratorConfig = {
      db,
      authAdapter,
      defaultLocale,
      supportedLocales: resolvedSupportedLocales,
      createDependencies: (auth: AuthContext, options?): ContextDependencies => {
        const invocationEmitScope = createInvocationEmitScope();
        const locale = options?.locale ?? defaultLocale;
        const requestLogger = withLogMasking(
          createStructuredLogger({
            component,
            tenantId: auth.tenantId,
            actorId: auth.userId,
            maskKeys,
          }),
          maskKeys,
        );
        return wireContextDependencies(
          {
            db,
            auth,
            entities,
            events,
            bypassTenantScope: options?.bypassTenantScope,
            getCausationId: () => resolveInvocationCausationId(invocationEmitScope),
            encryptionKey,
          },
          {
            ...(requestFlowEngine
              ? { flows: createFlowService(requestFlowEngine, auth, flows) }
              : {}),
            ai: aiService,
            logger: requestLogger,
            config: config as unknown as Record<string, unknown>,
            translations: createTranslationService(translationRegistry, locale),
            invocationEmitScope,
            ...buildCapabilityRuntimeDeps(capabilities),
          },
        );
      },
    };

    return {
      config,
      db,
      capabilities,
      routeConfig,
      ...(queues?.isDurable ? { jobQueue: queues.jobs } : {}),
      closeQueues: async () => {
        await queues?.close();
      },
      closeDb: async () => {
        await closeDatabaseConnection(dbConnection);
      },
    };
  } catch (error) {
    await Promise.allSettled([queues?.close(), closeDatabaseConnection(dbConnection)]);
    throw error;
  }
}
