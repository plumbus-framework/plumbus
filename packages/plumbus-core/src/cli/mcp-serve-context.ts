// ── Shared wiring for plumbus mcp serve ──
// Builds registries, DB, auth, and RouteGeneratorConfig-compatible deps for MCP runtime.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { PromptRegistry } from '../ai/prompt-registry.js';
import type { RouteGeneratorConfig } from '../api/route-generator.js';
import { type AuthAdapter, createJwtAdapter } from '../auth/index.js';
import { loadConfig } from '../config/index.js';
import { createErrorService } from '../errors/index.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../data/connection.js';
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
import { loadServerExtensions } from '../runtime/load-extensions.js';
import { resolveRuntimeQueues } from '../runtime/queue-factory.js';
import type { EventQueue } from '../events/queue.js';
import { warn } from './utils.js';
import { discoverResources } from './discover.js';

export interface McpServeContext {
  config: PlumbusConfig;
  db: PostgresJsDatabase;
  capabilities: CapabilityRegistry;
  routeConfig: RouteGeneratorConfig;
  jobQueue?: EventQueue;
  closeQueues: () => Promise<void>;
  closeDb: () => Promise<void>;
}

async function resolveMcpServeAuthAdapter(config: PlumbusConfig): Promise<AuthAdapter> {
  if (config.mcp?.agents && Object.keys(config.mcp.agents).length > 0) {
    const { createMcpAuthAdapter } = await import('@plumbus/mcp');
    return createMcpAuthAdapter({
      agents: config.mcp.agents,
      envToken: process.env.PLUMBUS_MCP_TOKEN,
    });
  }
  const secret = config.auth.secret;
  const isDevelopmentPlaceholder = [
    'development-secret',
    'development-secret-placeholder-32chars-min',
  ].includes(secret?.trim() ?? '');
  if (config.environment === 'development' && !secret) {
    warn(
      'MCP authentication is not configured — development requests will be anonymous and only `access.public: true` capabilities will be callable. Configure mcp.agents or AUTH_SECRET for authenticated access. See docs/mcp/agent-authentication.md.',
    );
    return { authenticate: async () => null };
  }

  const validatedSecret = z
    .string()
    .refine((value) => value.trim().length >= 32 && !isDevelopmentPlaceholder)
    .safeParse(secret);
  if (!validatedSecret.success) {
    throw createErrorService().validation(
      'MCP serve requires mcp.agents or an explicit AUTH_SECRET of at least 32 non-padding characters; development placeholder secrets are not accepted. Anonymous access is available only in development.',
    );
  }

  warn(
    'mcp.agents is not configured — MCP Bearer tokens will be verified using auth.secret (AUTH_SECRET). See docs/mcp/agent-authentication.md.',
  );
  return createJwtAdapter({
    secret: validatedSecret.data,
    issuer: config.auth.issuer,
    audience: config.auth.audience,
  });
}

export async function buildMcpServeContext(): Promise<McpServeContext> {
  const config = loadConfig();
  // Reject unsafe auth configuration before discovery or opening DB/queue connections.
  const authAdapter = await resolveMcpServeAuthAdapter(config);
  const resources = await discoverResources();

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

  const queues = await resolveRuntimeQueues(config);

  const translationRegistry = new TranslationRegistry();
  translationRegistry.registerAll(resources.translations ?? []);
  const defaultLocale = resources.translations?.[0]?.defaultLocale ?? 'en';
  const supportedLocales = translationRegistry.getSupportedLocales();
  const resolvedSupportedLocales = supportedLocales.length > 0 ? supportedLocales : [defaultLocale];
  const maskKeys = entities.getMaskedFieldNames();
  const encryptionKey = resolveEncryptionKey();

  const extensions = await loadServerExtensions();

  const aiService = buildWorkerAiService({
    config,
    db,
    promptRegistry,
    entities,
    onAICostRecorded: extensions.onAICostRecorded,
    resolveAiOverrides: extensions.resolveAiOverrides,
    enableStrictStructuredOutputs: extensions.enableStrictStructuredOutputs,
  });

  const requestFlowEngine = createFlowEngine({
    db,
    registry: flows,
    stepDeps: {
      async executeCapability() {
        return {
          success: false,
          error: 'Flow execution is worker-owned in MCP serve bootstrap',
        };
      },
      evaluateCondition() {
        return false;
      },
    },
  });

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
          component: 'mcp-capability',
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
          flows: createFlowService(requestFlowEngine, auth, flows),
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
    ...(queues.isDurable ? { jobQueue: queues.jobs } : {}),
    closeQueues: () => queues.close(),
    closeDb: async () => {
      await closeDatabaseConnection(dbConnection);
    },
  };
}
