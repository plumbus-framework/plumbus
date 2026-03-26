// ── Fastify Server Bootstrap ──
// Wires together all runtime components into a running Fastify server:
// config loading, database, queue, registries, routes, auth, audit, health check.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { createAIService, singleProviderConfig } from '../ai/ai-service.js';
import { createCostTracker } from '../ai/cost-tracker.js';
import type { PromptRegistry } from '../ai/prompt-registry.js';
import { createProviderAdapter } from '../ai/provider.js';
import type { RouteGeneratorConfig } from '../api/route-generator.js';
import { registerAllRoutes } from '../api/route-generator.js';
import { createAuditService } from '../audit/service.js';
import type { AuthAdapter } from '../auth/adapter.js';
import { createJwtAdapter } from '../auth/adapter.js';
import type { EntityRegistry } from '../data/registry.js';
import type { ConsumerRegistry } from '../events/consumer-registry.js';
import { createEventEmitter } from '../events/emitter.js';
import type { EventRegistry } from '../events/registry.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import type { FlowRegistry } from '../flows/registry.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AIService, LoggerService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';

// ── Server Config ──

export interface ServerConfig {
  /** Plumbus framework config */
  config: PlumbusConfig;
  /** Database connection (caller provides; server does not own connection lifecycle) */
  db: PostgresJsDatabase;
  /** Pre-populated registries */
  capabilities: CapabilityRegistry;
  entities: EntityRegistry;
  events: EventRegistry;
  consumers: ConsumerRegistry;
  flows: FlowRegistry;
  /** Optional prompt registry for AI schema validation */
  promptRegistry?: PromptRegistry;
  /** Optional custom auth adapter (default: JWT from config) */
  authAdapter?: AuthAdapter;
  /** Optional custom logger */
  logger?: LoggerService;
  /** Fastify listen host (default: "0.0.0.0") */
  host?: string;
  /** Fastify listen port (default: 3000) */
  port?: number;
  /** Trust proxy for X-Forwarded-For / X-Forwarded-Proto headers. Passed to Fastify's trustProxy option. */
  trustProxy?: boolean | string | string[] | number;
  /** Called after all capability routes are registered. Use to add custom routes (e.g. streaming). */
  onRoutesRegistered?: (app: FastifyInstance, routeConfig: RouteGeneratorConfig) => void;
  /**
   * Called when a capability execution fails with a non-success result.
   * Use to log errors to a system log table, send alerts, etc.
   * Runs after the error response has been sent — exceptions are caught and logged.
   */
  onCapabilityError?: (info: {
    capabilityName: string;
    domain: string;
    errorCode: string;
    errorMessage: string;
    metadata?: Record<string, unknown>;
    userId?: string;
    tenantId?: string;
    sourceIp?: string;
    userAgent?: string;
  }) => void | Promise<void>;
  /**
   * Optional async hook to resolve AI config overrides dynamically (e.g. from DB).
   * Called before each AI generate/stream call. The framework passes the DB connection.
   * Return default model/provider and per-prompt overrides.
   * Merges with (and takes priority over) env-based config.
   */
  resolveAiOverrides?: (db: PostgresJsDatabase) => Promise<{
    defaultModel?: string;
    defaultProvider?: string;
    promptOverrides?: Record<
      string,
      { provider?: string; model?: string; temperature?: number; maxTokens?: number }
    >;
  }>;
}

// ── Server Instance ──

export interface PlumbusServer {
  /** Underlying Fastify instance */
  app: FastifyInstance;
  /** Start listening */
  start(): Promise<string>;
  /** Graceful shutdown */
  stop(): Promise<void>;
}

/** Create and configure a Plumbus Fastify server */
export function createServer(serverConfig: ServerConfig): PlumbusServer {
  const {
    config,
    db,
    capabilities,
    entities,
    events,
    consumers,
    flows,
    host = '0.0.0.0',
    port = 3000,
    trustProxy,
  } = serverConfig;

  const logger = serverConfig.logger ?? createConsoleLogger(config.environment);

  // Auth adapter
  if (!config.auth.secret && config.environment !== 'development') {
    throw new Error(
      'auth.secret is required outside development — refusing to start with no secret',
    );
  }
  if (!config.auth.secret) {
    logger.warn(
      'No auth.secret configured — using insecure development fallback. Do NOT use in production.',
    );
  }
  const authAdapter =
    serverConfig.authAdapter ??
    createJwtAdapter({
      secret: config.auth.secret ?? 'development-secret',
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });

  // Fastify instance
  const app = Fastify({
    logger:
      config.environment !== 'production'
        ? {
            level: config.environment === 'development' ? 'debug' : 'info',
          }
        : {
            level: 'info',
          },
    ...(trustProxy != null && { trustProxy }),
  });

  // Health check endpoint
  app.get('/health', async () => ({
    status: 'ok',
    environment: config.environment,
    timestamp: new Date().toISOString(),
    capabilities: capabilities.getAll().length,
  }));

  // Readiness check (verifies DB is reachable)
  app.get('/ready', async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: 'ready' };
    } catch {
      reply.status(503);
      return { status: 'not_ready', reason: 'database unavailable' };
    }
  });

  // AI service wiring
  let aiService: AIService | undefined;

  if (config.aiProviders) {
    // Multi-provider setup
    const providerAdapters: Record<string, ReturnType<typeof createProviderAdapter>> = {};
    for (const [name, provCfg] of Object.entries(config.aiProviders.providers)) {
      providerAdapters[name] = createProviderAdapter(name, provCfg);
    }
    const costTracker = createCostTracker({
      maxTokensPerRequest: Object.values(config.aiProviders.providers)[0]?.maxTokensPerRequest,
      dailyCostLimit: Object.values(config.aiProviders.providers)[0]?.dailyCostLimit,
    });
    const aiServiceConfig: import('../ai/ai-service.js').AIServiceConfig = {
      providers: providerAdapters,
      defaultProvider: config.aiProviders.defaultProvider,
      defaultModel: config.aiProviders.defaultModel,
      costTracker,
      promptRegistry: serverConfig.promptRegistry,
      promptOverrides: config.aiProviders.promptOverrides
        ? { ...config.aiProviders.promptOverrides }
        : undefined,
    };
    aiService = createAIService(aiServiceConfig);

    // Wrap AI service with dynamic prompt overrides resolver
    if (serverConfig.resolveAiOverrides) {
      aiService = wrapAIServiceWithDynamicOverrides(
        aiService,
        aiServiceConfig,
        serverConfig.resolveAiOverrides,
        db,
      );
    }

    logger.info(
      `AI service configured with ${Object.keys(providerAdapters).length} providers (default: ${config.aiProviders.defaultProvider})`,
    );
  } else if (config.ai) {
    // Single-provider setup (legacy)
    const adapter = createProviderAdapter(config.ai.provider, config.ai);
    const costTracker = createCostTracker({
      maxTokensPerRequest: config.ai.maxTokensPerRequest,
      dailyCostLimit: config.ai.dailyCostLimit,
    });
    aiService = createAIService(
      singleProviderConfig(adapter, { costTracker, promptRegistry: serverConfig.promptRegistry }),
    );
    logger.info(`AI service configured with single provider: ${config.ai.provider}`);
  }

  // Route generator config
  const routeConfig: RouteGeneratorConfig = {
    authAdapter,
    createDependencies: (auth: AuthContext, options?): ContextDependencies => {
      const audit = createAuditService({ db, auth });
      const data = entities.createDataService({
        db,
        auth,
        audit,
        bypassTenantScope: options?.bypassTenantScope,
      });
      const eventService = createEventEmitter({ db, auth, registry: events, audit });

      return {
        auth,
        data,
        events: eventService,
        ai: aiService,
        audit,
        logger,
        config: config as unknown as Record<string, unknown>,
      };
    },
    onCapabilityError: serverConfig.onCapabilityError,
  };

  // Register all capability routes
  registerAllRoutes(app, capabilities.getAll(), routeConfig);

  // Allow consumer to register additional routes (e.g., streaming endpoints)
  if (serverConfig.onRoutesRegistered) {
    serverConfig.onRoutesRegistered(app, routeConfig);
  }

  logger.info(`Registered ${capabilities.getAll().length} capability routes`);

  // Log registration status for other registries.
  // Event consumers, flow triggers, and entity repositories are
  // wired by the caller — the server only handles HTTP route generation.
  if (events.getAll().length > 0) {
    logger.info(
      `${events.getAll().length} events registered (consumer wiring is caller responsibility)`,
    );
  }
  if (consumers.getAll().length > 0) {
    logger.info(
      `${consumers.getAll().length} event consumers registered (wiring is caller responsibility)`,
    );
  }
  if (flows.getAll().length > 0) {
    logger.info(
      `${flows.getAll().length} flows registered (trigger/scheduler wiring is caller responsibility)`,
    );
  }
  if (entities.getAllEntities().length > 0) {
    logger.info(`${entities.getAllEntities().length} entities registered`);
  }

  return {
    app,
    async start() {
      const address = await app.listen({ host, port });
      logger.info(`Plumbus server listening on ${address}`);
      return address;
    },
    async stop() {
      logger.info('Shutting down Plumbus server...');
      await app.close();
      logger.info('Server stopped');
    },
  };
}

// ── Dynamic Prompt Overrides Wrapper ──

/**
 * Wraps an AI service to call a resolver before each AI invocation.
 * The resolver returns dynamic overrides (e.g. from DB) that are merged
 * into the AI service config, taking priority over env-based config.
 */
export function wrapAIServiceWithDynamicOverrides(
  base: AIService,
  aiServiceConfig: import('../ai/ai-service.js').AIServiceConfig,
  resolver: NonNullable<ServerConfig['resolveAiOverrides']>,
  db: PostgresJsDatabase,
): AIService {
  async function refreshOverrides(): Promise<void> {
    const dynamic = await resolver(db);
    if (dynamic.defaultModel) {
      aiServiceConfig.defaultModel = dynamic.defaultModel;
    }
    if (dynamic.defaultProvider) {
      aiServiceConfig.defaultProvider = dynamic.defaultProvider;
    }
    if (dynamic.promptOverrides) {
      aiServiceConfig.promptOverrides = {
        ...aiServiceConfig.promptOverrides,
        ...dynamic.promptOverrides,
      };
    }
  }

  return {
    async generate(params) {
      await refreshOverrides();
      return base.generate(params);
    },
    async generateWithUsage(params) {
      await refreshOverrides();
      return base.generateWithUsage(params);
    },
    async *streamGenerate(params) {
      await refreshOverrides();
      yield* base.streamGenerate(params);
    },
    extract: base.extract.bind(base),
    classify: base.classify.bind(base),
    retrieve: base.retrieve.bind(base),
  };
}

// ── Console Logger ──

function createConsoleLogger(env: string): LoggerService {
  const prefix = `[plumbus:${env}]`;
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
