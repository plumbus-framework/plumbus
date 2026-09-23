import type { DecisionRuntimeConfig } from '@plumbus/ai-decision/types';
import type { IdempotencyStore } from '../api/idempotency.js';
import type { AIReasoningConfig, ReasoningEffort } from '../types/prompt.js';
// ── Fastify Server Bootstrap ──
// Wires together all runtime components into a running Fastify server:
// config loading, database, queue, registries, routes, auth, audit, health check.

import { sql } from 'drizzle-orm';
import { FRAMEWORK_SCHEMA, resolveFrameworkSchema } from '../data/schema-generator.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { createAIService, singleProviderConfig } from '../ai/ai-service.js';
import type { AICostRecord } from '../ai/cost-tracker.js';
import { createCostTracker } from '../ai/cost-tracker.js';
import type { GovernedArtifactStore } from '../ai/governed-artifacts.js';
import { resolveGovernedArtifactStore } from '../ai/governed-artifacts.js';
import type { PromptRegistry } from '../ai/prompt-registry.js';
import { createProviderAdapter } from '../ai/provider.js';
import { buildAISecurityConfig } from '../ai/security.js';
import type { DependencyOptions, RouteGeneratorConfig } from '../api/route-generator.js';
import { registerAllRoutes } from '../api/route-generator.js';
import { hostApprovalRuntimeExtras } from '../approvals/host-runtime.js';
import type { ApprovalService, AuthorizationProvider } from '../approvals/types.js';
import type { AuthAdapter } from '../auth/adapter.js';
import { createJwtAdapter } from '../auth/adapter.js';
import type { CredentialCatalog } from '../credentials/catalog.js';
import { resolveEncryptionKey } from '../data/field-encryption.js';
import type { EntityRegistry } from '../data/registry.js';
import { logHookError } from '../errors/hook-log.js';
import { GENERIC_INTERNAL_MESSAGE } from '../errors/http.js';
import { PlumbusError, isPlumbusError } from '../errors/index.js';
import type { ConsumerRegistry } from '../events/consumer-registry.js';
import type { EventQueue } from '../events/queue.js';
import type { EventRegistry } from '../events/registry.js';
import { buildCapabilityRuntimeDeps } from '../execution/capability-invocation.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import { wireContextDependencies } from '../execution/context-deps.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import {
  createInvocationEmitScope,
  resolveInvocationCausationId,
} from '../execution/invocation-emit-scope.js';
import {
  type CompiledFlowRegistry,
  resolveCompiledFlowRegistry,
} from '../flows/compiled-registry.js';
import { createFlowEngine, type FlowSpineDispatchConfig } from '../flows/engine.js';
import { createFlowService } from '../flows/flow-service.js';
import type { FlowRegistry } from '../flows/registry.js';
import { createJobDispatchService } from '../jobs/job-dispatch-service.js';
import { registerJobStatusRoute } from '../jobs/routes.js';
import { JobExecutionSource } from '../jobs/schema.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import { createStructuredLogger, withLogMasking } from '../observability/metrics.js';
import {
  warnAiSecurityBlockMode,
  warnEncryptedFieldsWithoutKey,
} from '../runtime/startup-warnings.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import { createTranslationService, TranslationRegistry } from '../translations/index.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AICostContext, AIService, LoggerService } from '../types/context.js';
import { ErrorCode } from '../types/enums.js';
import type { AuthContext } from '../types/security.js';
import type { TranslationDefinition } from '../types/translation.js';
import type { HttpAuthenticationRuntime } from './authentication-runtime.js';

// ── Server Config ──

const denyAllAuthAdapter: AuthAdapter = {
  authenticate: async () => null,
};

/**
 * What a request whose auth context carries no tenant resolves to, once a
 * `dataPlaneResolver` is configured.
 *
 * `'refuse'` is the default and the fail-closed choice: with more than one data
 * plane in play there is no safe guess about which database an untenanted
 * request meant, so the request is rejected rather than served from whichever
 * database happens to be at hand. `'control-plane'` opts a deployment into
 * serving those requests from the boot-time `db` — appropriate when untenanted
 * traffic is genuinely control-plane work (sign-up, tenant directory lookups,
 * cluster health) and nothing tenant-scoped lives in that database.
 */
export type UntenantedDataPlanePolicy = 'refuse' | 'control-plane';

export interface ServerConfig {
  /** Plumbus framework config */
  config: PlumbusConfig;
  /**
   * Database connection (caller provides; server does not own connection lifecycle).
   *
   * With no `dataPlaneResolver` this is the database every request uses. With
   * one, it is the control plane: readiness probes, the job-status route, AI
   * override/cost hooks and the process-error hook keep addressing it, and
   * requests reach it only under `untenantedDataPlane: 'control-plane'`.
   */
  db: PostgresJsDatabase;
  /** Pre-populated registries */
  capabilities: CapabilityRegistry;
  entities: EntityRegistry;
  events: EventRegistry;
  consumers: ConsumerRegistry;
  flows: FlowRegistry;
  /** Discovered translation definitions from app/translations */
  translations?: TranslationDefinition[];
  /** Optional prompt registry for AI schema validation */
  promptRegistry?: PromptRegistry;
  /** Registered decision providers, named definitions, and optional shared AI budget. */
  decisions?: DecisionRuntimeConfig;
  /** Optional custom auth adapter (default: JWT from config) */
  authAdapter?: AuthAdapter;
  /** Optional session/OIDC authentication runtime, e.g. from @plumbus/auth */
  authenticationRuntime?: HttpAuthenticationRuntime;
  /**
   * Optional host credential catalog. Names, types, refs, and public labels
   * only — secret values stay in the host resolver until `reveal`. Omitted:
   * existing hosts boot unchanged. The catalog is retained on the returned
   * server; it is never logged.
   */
  credentials?: CredentialCatalog;
  /**
   * Optional governed prompt/policy artifact store. Omitted: existing hosts
   * boot unchanged. Retained on the returned server; never logged.
   */
  artifacts?: GovernedArtifactStore;
  /**
   * Directory for the filesystem governed artifact store. Used when `artifacts`
   * is omitted. An explicit path is created if missing. Omitted:
   * `{cwd}/.plumbus/governed-artifacts` is opened when that directory exists.
   */
  artifactsDirectory?: string;
  /** Optional custom logger */
  logger?: LoggerService;
  /** Fastify listen host (default: "0.0.0.0") */
  host?: string;
  /** Fastify listen port. Required to call `start()` — no default is assumed. */
  port?: number;
  /** Trust proxy for X-Forwarded-For / X-Forwarded-Proto headers. Passed to Fastify's trustProxy option. */
  trustProxy?: boolean | string | string[] | number;
  /**
   * Largest request body the server accepts, in bytes. Passed to Fastify's `bodyLimit`.
   *
   * Fastify's default is 1 MiB, which is right for an API of JSON capability calls and wrong the
   * moment one capability carries a file: an application that accepts a 10 MiB upload as a base64
   * field answers `413` to every file above ~700 KB and never reaches its own quota check. Left
   * unset, the default stands.
   */
  bodyLimit?: number;
  /** Jobs queue for async kind: 'job' capabilities (when API wires jobQueue). */
  jobQueue?: EventQueue;
  /**
   * Store for `api.idempotency` claims on the `/api` surface. Unset: one in-memory store per
   * server (per process); supply a shared store for replay protection across instances.
   */
  idempotencyStore?: IdempotencyStore;
  /** Expose Prometheus metrics at GET /metrics (colocated role=all deployments). */
  metrics?: PlumbusMetrics;
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
    db?: PostgresJsDatabase;
  }) => void | Promise<void>;
  /**
   * Called on uncaught exceptions, unhandled rejections, and Fastify-level errors.
   * Use to log process-level crashes that bypass capability/flow hooks.
   * The `source` field indicates origin: 'uncaughtException', 'unhandledRejection', 'fastify', or 'startup'.
   */
  onProcessError?: (info: {
    source: 'uncaughtException' | 'unhandledRejection' | 'fastify' | 'startup';
    message: string;
    stack?: string;
    metadata?: Record<string, unknown>;
    db?: PostgresJsDatabase;
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
      {
        provider?: string;
        model?: string;
        temperature?: number;
        maxTokens?: number;
        reasoning?: AIReasoningConfig;
        /** @deprecated Use `reasoning`. */
        reasoningEffort?: ReasoningEffort;
      }
    >;
  }>;
  /**
   * Called after every AI invocation completes (success or failure) and the
   * in-memory cost tracker has been updated. Use this to persist a ledger
   * row per AI call — the `record` carries `status: 'success' | 'failed'`
   * plus typed structured-output failures (`'refused'`, `'incomplete'`)
   * so sunk provider-side spend on failed retries is visible to billing.
   * The framework passes the DB connection. Hook errors are logged but
   * never propagate to the caller.
   */
  onAICostRecorded?: (
    record: AICostRecord,
    costContext: AICostContext | undefined,
    db: PostgresJsDatabase,
  ) => void | Promise<void>;
  /** Immediate per-tenant/provider/package admission for outbound AI calls. */
  aiProviderConcurrency?: import('../ai/ai-service.js').AIProviderConcurrencyConfig;
  /** Trusted outbound propagation headers for each provider attempt. */
  resolveAIProviderHeaders?: import('../ai/ai-service.js').AIServiceConfig['resolveProviderHeaders'];
  /** Best-effort provider client span exporter. */
  onAIProviderSpan?: import('../ai/ai-service.js').AIServiceConfig['onProviderSpan'];
  /** Enable provider-side constrained decoding for registered prompt output schemas. */
  enableStrictStructuredOutputs?: boolean;
  /**
   * Resolve each request's database from its tenant instead of using `db` for
   * all of them.
   *
   * Omitted (the default) the server behaves exactly as it always has: one
   * boot-time connection, dependencies built synchronously, nothing extra
   * awaited per request. Supplied, every request's auth context is mapped to a
   * tenant reference (`resolveTenantRef`, `auth.tenantId` by default), that
   * reference is resolved to a data plane, and the request's repositories,
   * events, audit, transactions and job dispatch are all wired against the
   * resolved handle's database. A reference the resolver does not recognise
   * fails the request — no path substitutes another tenant's database.
   */
  dataPlaneResolver?: DataPlaneResolver;
  /** Policy for requests carrying no tenant reference. Default: `'refuse'`. */
  untenantedDataPlane?: UntenantedDataPlanePolicy;
  /**
   * What `dataPlaneResolver` resolves for a request.
   *
   * `'resolved'` (the default) is the full mode described above: repositories, events,
   * audit, transactions, job dispatch and the flows a request starts all go to the resolved
   * plane. `'control-plane'` keeps every request's repositories on `db` — for a host that
   * routes tenant data itself, through its own connections — and still places the **flows**
   * a request starts on the tenant plane the resolver names, with the spine holding only the
   * opaque dispatch hint. Either way a capability that declared `tenantScoped: false` runs
   * against `db`: control-plane work reads control-plane tables whatever tenant the request
   * was bound to.
   */
  requestDataPlane?: 'resolved' | 'control-plane';
  /** The framework schema tenant planes carry (PLUMBUS_FRAMEWORK_SCHEMA). Default: resolveFrameworkSchema(). Drives the flow engine's durable-dispatch qualification and the outbox dispatcher's pump. */
  frameworkSchema?: string;
  /**
   * Map an auth context to the reference `dataPlaneResolver` is keyed by.
   * Defaults to `auth.tenantId`. Override when the resolver is keyed by
   * something the host derives instead (a region-qualified reference, a slug).
   */
  resolveTenantRef?: (auth: AuthContext) => string | undefined;
  /**
   * Optional approval service for the capability-pipeline gate.
   * Omitted: existing hosts boot unchanged (consequential caps fail closed
   * only when they declare `riskTier: 'consequential'`).
   */
  approvals?: ApprovalService;
  /**
   * Host authorization revalidation after an approval wait.
   * Do not invent a production provider here — the host application supplies it.
   * Harness tests may pass `createAllowAllAuthorizationProvider`.
   */
  authorizationProvider?: AuthorizationProvider;
  /**
   * Compiled flow definitions. When set, HTTP start/inspect
   * pins the same signed JSON the worker consumes.
   */
  compiledRegistry?: CompiledFlowRegistry;
  /**
   * Directory of `plumbus compile-flows` JSON. Used when `compiledRegistry`
   * is omitted. An explicit path that is missing, empty, or tampered fails
   * closed. Omitted: `{cwd}/.plumbus/compiled-flows` is loaded when it has JSON.
   */
  compiledFlowsDirectory?: string;
}

// ── Server Instance ──

export interface PlumbusServer {
  /** Underlying Fastify instance */
  app: FastifyInstance;
  /** Start listening */
  start(): Promise<string>;
  /** Graceful shutdown */
  stop(): Promise<void>;
  /** Host credential catalog when `createServer({ credentials })` was given. */
  credentials?: CredentialCatalog;
  /** Governed artifact store when one was passed or auto-loaded from disk. */
  artifacts?: GovernedArtifactStore;
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
    port,
    trustProxy,
    bodyLimit,
  } = serverConfig;

  const logger = serverConfig.logger ?? createConsoleLogger(config.environment);
  const translationRegistry = new TranslationRegistry();
  translationRegistry.registerAll(serverConfig.translations ?? []);
  const defaultLocale = serverConfig.translations?.[0]?.defaultLocale ?? 'en';
  const supportedLocales = translationRegistry.getSupportedLocales();
  const resolvedSupportedLocales = supportedLocales.length > 0 ? supportedLocales : [defaultLocale];
  const maskKeys = entities.getMaskedFieldNames();
  const encryptionKey = resolveEncryptionKey();
  warnEncryptedFieldsWithoutKey(entities, encryptionKey, logger);
  warnAiSecurityBlockMode(config, logger);

  // Auth adapter
  if (
    !config.auth.secret &&
    config.environment !== 'development' &&
    !serverConfig.authAdapter &&
    !serverConfig.authenticationRuntime
  ) {
    throw new Error(
      'auth.secret is required outside development — refusing to start with no secret',
    );
  }
  const useDefaultJwtAdapter =
    !serverConfig.authAdapter && !serverConfig.authenticationRuntime && Boolean(config.auth.secret);
  if (!config.auth.secret && !serverConfig.authAdapter && !serverConfig.authenticationRuntime) {
    logger.warn(
      'No auth.secret configured — development requests are anonymous; configure AUTH_SECRET for JWT authentication.',
    );
  }
  const authAdapter =
    serverConfig.authAdapter ??
    (useDefaultJwtAdapter
      ? createJwtAdapter({
          secret: config.auth.secret ?? '',
          issuer: config.auth.issuer,
          audience: config.auth.audience,
        })
      : denyAllAuthAdapter);

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
    ...(bodyLimit != null && { bodyLimit }),
  });

  // Health check endpoint
  app.get('/health', async () => {
    const authHealth = serverConfig.authenticationRuntime?.describeHealth?.();
    return {
      status: 'ok',
      environment: config.environment,
      timestamp: new Date().toISOString(),
      capabilities: capabilities.getAll().length,
      ...(authHealth ? { components: { auth: authHealth } } : {}),
    };
  });

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

  if (serverConfig.metrics) {
    app.get('/metrics', async () => serverConfig.metrics?.registry.serialize());
  }

  // AI service wiring
  let aiService: AIService | undefined;

  // Adapt the consumer-facing `onAICostRecorded(record, ctx, db)` into the
  // inner AI-service-level `OnAICostRecorded(record, ctx)` contract by
  // pre-binding the DB. Undefined passes through unchanged.
  const onAICostRecordedAdapter = serverConfig.onAICostRecorded
    ? (record: AICostRecord, costContext: AICostContext | undefined) =>
        serverConfig.onAICostRecorded?.(record, costContext, db)
    : undefined;

  if (config.aiProviders) {
    // Multi-provider setup
    const providerAdapters: Record<string, ReturnType<typeof createProviderAdapter>> = {};
    for (const [name, provCfg] of Object.entries(config.aiProviders.providers)) {
      providerAdapters[name] = createProviderAdapter(name, provCfg);
    }
    const costTracker = createCostTracker({
      maxTokensPerRequest: Object.values(config.aiProviders.providers)[0]?.maxTokensPerRequest,
      dailyCostLimit: Object.values(config.aiProviders.providers)[0]?.dailyCostLimit,
      ...serverConfig.decisions?.budget,
    });
    const aiServiceConfig: import('../ai/ai-service.js').AIServiceConfig = {
      providers: providerAdapters,
      decisions: serverConfig.decisions,
      defaultProvider: config.aiProviders.defaultProvider,
      defaultModel: config.aiProviders.defaultModel,
      costTracker,
      promptRegistry: serverConfig.promptRegistry,
      promptOverrides: config.aiProviders.promptOverrides
        ? { ...config.aiProviders.promptOverrides }
        : undefined,
      onAICostRecorded: onAICostRecordedAdapter,
      providerConcurrency: serverConfig.aiProviderConcurrency,
      resolveProviderHeaders: serverConfig.resolveAIProviderHeaders,
      onProviderSpan: serverConfig.onAIProviderSpan,
      enableStrictStructuredOutputs: serverConfig.enableStrictStructuredOutputs,
      security: buildAISecurityConfig(
        entities.getAllEntities(),
        config.aiProviders.security ?? (serverConfig.decisions ? {} : undefined),
      ),
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
      ...serverConfig.decisions?.budget,
    });
    aiService = createAIService(
      singleProviderConfig(adapter, {
        decisions: serverConfig.decisions,
        security: serverConfig.decisions
          ? buildAISecurityConfig(entities.getAllEntities(), {})
          : undefined,
        costTracker,
        promptRegistry: serverConfig.promptRegistry,
        onAICostRecorded: onAICostRecordedAdapter,
        providerConcurrency: serverConfig.aiProviderConcurrency,
        resolveProviderHeaders: serverConfig.resolveAIProviderHeaders,
        onProviderSpan: serverConfig.onAIProviderSpan,
        enableStrictStructuredOutputs: serverConfig.enableStrictStructuredOutputs,
      }),
    );
    logger.info(`AI service configured with single provider: ${config.ai.provider}`);
  }

  if (!aiService && serverConfig.decisions) {
    aiService = createAIService({
      providers: {},
      defaultProvider: '',
      decisions: serverConfig.decisions,
      costTracker: createCostTracker(serverConfig.decisions.budget),
      onAICostRecorded: onAICostRecordedAdapter,
      security: buildAISecurityConfig(
        entities.getAllEntities(),
        config.aiProviders?.security ?? {},
      ),
    });
  }

  // Route generator config
  // Flow steps are executed by the worker process, never by the HTTP server;
  // the engine here exists so capabilities can start and inspect flows.
  const httpFlowStepDeps = {
    async executeCapability() {
      return {
        success: false,
        error: 'Flow execution is worker-owned in HTTP server bootstrap',
      };
    },
    evaluateCondition() {
      return false;
    },
  };
  const artifacts = resolveGovernedArtifactStore({
    artifacts: serverConfig.artifacts,
    artifactsDirectory: serverConfig.artifactsDirectory,
  });
  const compiledRegistry = resolveCompiledFlowRegistry({
    compiledRegistry: serverConfig.compiledRegistry,
    compiledFlowsDirectory: serverConfig.compiledFlowsDirectory,
  });
  /**
   * Flows a request starts are placed where the resolver says the tenant's state lives
   * (`spineDispatch`): the execution row on the tenant plane, an opaque hint on `db`, the
   * spine. Without a resolver an engine writes its own `db`, as it always has.
   */
  const requestSpineDispatch: FlowSpineDispatchConfig | undefined = serverConfig.dataPlaneResolver
    ? {
        db,
        resolver: serverConfig.dataPlaneResolver,
        untenanted: serverConfig.untenantedDataPlane ?? 'refuse',
        // The host's framework schema (PLUMBUS_FRAMEWORK_SCHEMA): the flow engine qualifies
        // the tenant's durable tables (execution_state, dispatch_outbox) with it, and the
        // outbox dispatcher's pump reads the same tables. One resolution for every writer
        // and reader — the host's name, else PLUMBUS_FRAMEWORK_SCHEMA, else the framework
        // default — or the pump reads a schema the engine never wrote.
        coreSchema: serverConfig.frameworkSchema ?? resolveFrameworkSchema() ?? FRAMEWORK_SCHEMA,
      }
    : undefined;
  const requestFlowEngine = createFlowEngine({
    db,
    registry: flows,
    stepDeps: httpFlowStepDeps,
    compiledRegistry,
    spineDispatch: requestSpineDispatch,
  });

  /**
   * One flow engine per data plane. A flow started by a capability belongs in
   * the same database as the rows that capability wrote, so an engine bound to
   * the boot connection cannot be reused for a resolved tenant. Keyed weakly so
   * an engine is collected with the connection it wraps.
   */
  const flowEnginesByDataPlane = new WeakMap<
    PostgresJsDatabase,
    ReturnType<typeof createFlowEngine>
  >();
  flowEnginesByDataPlane.set(db, requestFlowEngine);

  function flowEngineFor(dataPlaneDb: PostgresJsDatabase): ReturnType<typeof createFlowEngine> {
    const existing = flowEnginesByDataPlane.get(dataPlaneDb);
    if (existing) return existing;
    const engine = createFlowEngine({
      db: dataPlaneDb,
      registry: flows,
      stepDeps: httpFlowStepDeps,
      compiledRegistry,
      spineDispatch: requestSpineDispatch,
    });
    flowEnginesByDataPlane.set(dataPlaneDb, engine);
    return engine;
  }

  function buildRequestDependencies(
    requestDb: PostgresJsDatabase,
    auth: AuthContext,
    options?: DependencyOptions,
  ): ContextDependencies {
    const invocationEmitScope = createInvocationEmitScope();
    const locale = options?.locale ?? defaultLocale;
    const baseLogger =
      serverConfig.logger ??
      createStructuredLogger({
        component: 'capability',
        tenantId: auth.tenantId,
        actorId: auth.userId,
        maskKeys,
      });
    const requestLogger = withLogMasking(baseLogger, maskKeys);
    const capRuntime = buildCapabilityRuntimeDeps(capabilities);
    return wireContextDependencies(
      {
        db: requestDb,
        auth,
        entities,
        events,
        bypassTenantScope: options?.bypassTenantScope,
        getCausationId: () => resolveInvocationCausationId(invocationEmitScope),
        encryptionKey,
      },
      {
        flows: createFlowService(flowEngineFor(requestDb), auth, flows),
        ...(serverConfig.jobQueue
          ? {
              jobs: createJobDispatchService({
                db: requestDb,
                jobQueue: serverConfig.jobQueue,
                resolveCapability: (name) => capabilities.get(name),
                auth,
                getCorrelationId: () => resolveInvocationCausationId(invocationEmitScope),
                source: JobExecutionSource.Http,
              }),
            }
          : {}),
        ai: aiService,
        logger: requestLogger,
        config: config as unknown as Record<string, unknown>,
        translations: createTranslationService(translationRegistry, locale),
        invocationEmitScope,
        ...capRuntime,
        ...hostApprovalRuntimeExtras(serverConfig),
        ...(artifacts ? { artifacts } : {}),
      },
    );
  }

  const dataPlaneResolver = serverConfig.dataPlaneResolver;
  const untenantedDataPlane = serverConfig.untenantedDataPlane ?? 'refuse';
  const resolveTenantRef = serverConfig.resolveTenantRef ?? ((auth: AuthContext) => auth.tenantId);
  const requestDataPlane = serverConfig.requestDataPlane ?? 'resolved';

  async function resolveRequestDb(
    resolver: DataPlaneResolver,
    auth: AuthContext,
  ): Promise<PostgresJsDatabase> {
    const tenantRef = resolveTenantRef(auth);
    if (!tenantRef) {
      // Fail closed. With several data planes in play there is no safe guess
      // about which one an untenanted request meant.
      if (untenantedDataPlane === 'control-plane') return db;
      throw new PlumbusError(
        ErrorCode.Forbidden,
        'This deployment resolves a database per tenant and the request carries no tenant reference',
        { reason: 'untenanted-request' },
      );
    }
    const handle = await resolver.resolve(tenantRef);
    return handle.db;
  }

  const routeConfig: RouteGeneratorConfig = {
    db,
    authAdapter,
    requestAuthenticator: serverConfig.authenticationRuntime?.authenticator,
    defaultLocale,
    supportedLocales: resolvedSupportedLocales,
    createDependencies: (auth: AuthContext, options?): ContextDependencies =>
      buildRequestDependencies(db, auth, options),
    ...(dataPlaneResolver && requestDataPlane === 'resolved'
      ? {
          resolveDependencies: async (auth: AuthContext, options?) => {
            // `bypassTenantScope` is the route generator's word for a capability that declared
            // `tenantScoped: false`: control-plane work, which reads control-plane tables
            // whatever tenant the request happens to be bound to.
            const requestDb = options?.bypassTenantScope
              ? db
              : await resolveRequestDb(dataPlaneResolver, auth);
            return {
              dependencies: buildRequestDependencies(requestDb, auth, options),
              db: requestDb,
            };
          },
        }
      : {}),
    onCapabilityError: serverConfig.onCapabilityError,
    jobQueue: serverConfig.jobQueue,
    ...(serverConfig.idempotencyStore ? { idempotencyStore: serverConfig.idempotencyStore } : {}),
  };

  // Register all capability routes
  registerAllRoutes(app, capabilities.getAll(), routeConfig);

  registerJobStatusRoute(app, {
    db,
    authAdapter,
    requestAuthenticator: serverConfig.authenticationRuntime?.authenticator,
  });

  const authenticationRuntime = serverConfig.authenticationRuntime;
  if (authenticationRuntime) {
    app.register(async (instance) => {
      await authenticationRuntime.initialize();
      await authenticationRuntime.registerRoutes(instance);
    });
    app.addHook('onClose', async () => {
      await authenticationRuntime.close?.();
    });
  }

  // Fastify-level error handler — catches malformed requests, timeouts, uncaught route errors
  {
    const processErrorHook = serverConfig.onProcessError;
    app.setErrorHandler((err, request, reply) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const statusCode =
        typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500;
      // Transport-level refusals are client mistakes, not server faults: Fastify names them
      // with statusCode (415 unsupported media type, 400 malformed JSON body). Answering them
      // as 'internal' hid a request-shape mistake behind an outage-looking answer and leaked
      // the framework prose to the wire.
      if (statusCode < 500 && !isPlumbusError(err)) {
        reply.status(statusCode).send({
          error: {
            code: statusCode === 415 ? 'unsupported-media-type' : 'validation',
            message,
          },
        });
        return;
      }
      logger.error(`Fastify error: ${message}`, {
        url: request.url,
        method: request.method,
        statusCode,
      });
      Promise.resolve()
        .then(() =>
          processErrorHook?.({
            source: 'fastify',
            message,
            stack,
            metadata: {
              url: request.url,
              method: request.method,
              statusCode,
              ip: request.ip,
            },
            db,
          }),
        )
        .catch((hookErr) => {
          logHookError('onCapabilityError', hookErr);
        });
      const clientMessage = statusCode >= 500 ? GENERIC_INTERNAL_MESSAGE : message;
      reply.status(statusCode).send({
        error: { code: 'internal', message: clientMessage },
      });
    });
  }

  // Allow consumer to register additional routes (e.g., streaming endpoints)
  if (serverConfig.onRoutesRegistered) {
    serverConfig.onRoutesRegistered(app, routeConfig);
  }

  logger.info(`Registered ${capabilities.getAll().length} capability routes`);

  if (dataPlaneResolver) {
    logger.info(
      requestDataPlane === 'resolved'
        ? `Per-request data-plane resolution enabled (untenanted requests: ${untenantedDataPlane})`
        : `Flows started by requests are placed on tenant planes; repositories stay on the control plane (untenanted flows: ${untenantedDataPlane})`,
    );
  }

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
    credentials: serverConfig.credentials,
    artifacts,
    async start() {
      if (port == null) {
        throw new Error(
          'createServer({ port }) is required to listen. No default listen port is assumed.',
        );
      }
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
    withContext(identity) {
      const scopedConfig = { ...aiServiceConfig, budget: { ...identity } };
      return wrapAIServiceWithDynamicOverrides(
        createAIService(scopedConfig),
        scopedConfig,
        resolver,
        db,
      );
    },
    features: base.features,
    decide: (params) => base.decide(params),
    recordProviderCost(entry, costContext) {
      return base.recordProviderCost(entry, costContext);
    },
    checkProviderCostBudget(config) {
      return base.checkProviderCostBudget(config);
    },
    async generate(params) {
      await refreshOverrides();
      return base.generate(params);
    },
    generateWithUsage: (async (config: Parameters<AIService['generateWithUsage']>[0]) => {
      await refreshOverrides();
      return base.generateWithUsage(config);
    }) as AIService['generateWithUsage'],
    async *streamGenerate(params) {
      await refreshOverrides();
      yield* base.streamGenerate(params);
    },
    extract(params) {
      return base.extract(params);
    },
    classify(params) {
      return base.classify(params);
    },
    retrieve(params) {
      return base.retrieve(params);
    },
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
