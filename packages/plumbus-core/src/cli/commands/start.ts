// ── plumbus start ──
// Production server command: starts API server without watchers or dev tooling.
// Forces production environment and production-safe defaults.

import type { Command } from 'commander';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAIService, singleProviderConfig } from '../../ai/ai-service.js';
import { createCostTracker } from '../../ai/cost-tracker.js';
import { PromptRegistry } from '../../ai/prompt-registry.js';
import { createProviderAdapter } from '../../ai/provider.js';
import { loadConfig, validateConfig } from '../../config/loader.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { createInMemoryQueue } from '../../events/queue.js';
import { EventRegistry } from '../../events/registry.js';
import { executeCapability } from '../../execution/capability-executor.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { StepExecutorDeps } from '../../flows/step-executor.js';
import type { PlumbusServer } from '../../server/bootstrap.js';
import { createServer, wrapAIServiceWithDynamicOverrides } from '../../server/bootstrap.js';
import type { AIServiceConfig } from '../../ai/ai-service.js';
import type { AIService } from '../../types/context.js';
import type { WorkerPool } from '../../worker/bootstrap.js';
import { createWorkerPool } from '../../worker/bootstrap.js';
import { discoverResources } from '../discover.js';
import { info, error as logError } from '../utils.js';

export interface StartOptions {
  port?: string;
  host?: string;
}

/**
 * Start the production server.
 * Discovers resources from app/, populates registries, connects to DB,
 * and starts the Fastify server with production defaults.
 *
 * Unlike `plumbus dev`, this command:
 * - Forces `environment: "production"`
 * - Defaults host to `0.0.0.0` (accepts external connections)
 * - Requires `AUTH_SECRET` (fails fast if missing)
 * - No development warnings or verbose output
 */
export async function startProductionServer(options: StartOptions & { db?: unknown }): Promise<{
  server: PlumbusServer;
  shutdown: () => Promise<void>;
}> {
  const config = loadConfig({ environment: 'production' });
  const validation = validateConfig(config);

  if (!validation.valid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`);
  }

  const port = parseInt(options.port ?? '3000', 10);
  const host = options.host ?? '0.0.0.0';
  const serverUrl = `http://${host}:${port}`;

  info('Plumbus Production Server');
  info(`Server URL: ${serverUrl}`);

  // Auto-discover resources from app/ directory
  info('Discovering resources from app/ ...');
  const resources = await discoverResources();
  info(
    `Found ${resources.capabilities.length} capabilities, ${resources.entities.length} entities, ` +
      `${resources.flows.length} flows, ${resources.events.length} events, ${resources.prompts.length} prompts`,
  );

  // Populate registries
  const capabilities = new CapabilityRegistry();
  capabilities.registerAll(resources.capabilities);

  const entities = new EntityRegistry();
  entities.registerAll(resources.entities);

  const events = new EventRegistry();
  events.registerAll(resources.events);

  const flows = new FlowRegistry();
  flows.registerAll(resources.flows);

  const consumers = new ConsumerRegistry();

  const promptRegistry = new PromptRegistry();
  for (const prompt of resources.prompts) {
    promptRegistry.register(prompt);
  }

  // Connect to database
  let db = options.db;
  if (!db) {
    try {
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const postgres = (await import('postgres')).default;
      const sql = postgres({
        host: config.database.host,
        port: config.database.port,
        database: config.database.database,
        username: config.database.user,
        password: config.database.password,
      });
      db = drizzle(sql);
      info('Database connected');
    } catch (err) {
      throw new Error(
        `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Try to load server extensions from app/server.ts (or app/server.js)
  // Register tsx so dynamic import of .ts files works
  let unregisterTsx: (() => void) | undefined;
  try {
    const req = createRequire(import.meta.url);
    const tsxPath = req.resolve('tsx/esm/api');
    const tsx = await import(pathToFileURL(tsxPath).href);
    unregisterTsx = tsx.register();
  } catch {
    // tsx not available; only .js extensions will work
  }

  let onRoutesRegistered: import('../../server/bootstrap.js').ServerConfig['onRoutesRegistered'];
  let resolveAiOverrides: import('../../server/bootstrap.js').ServerConfig['resolveAiOverrides'];
  let onCapabilityError: import('../../server/bootstrap.js').ServerConfig['onCapabilityError'];
  let onFlowError: import('../../worker/bootstrap.js').WorkerPoolConfig['onFlowError'];
  for (const ext of ['app/server.ts', 'app/server.js']) {
    const extPath = path.resolve(process.cwd(), ext);
    if (fs.existsSync(extPath)) {
      try {
        const mod = await import(pathToFileURL(extPath).href);
        onRoutesRegistered = mod.onRoutesRegistered ?? mod.default?.onRoutesRegistered;
        resolveAiOverrides = mod.resolveAiOverrides ?? mod.default?.resolveAiOverrides;
        onCapabilityError = mod.onCapabilityError ?? mod.default?.onCapabilityError;
        onFlowError = mod.onFlowError ?? mod.default?.onFlowError;
        if (onRoutesRegistered) {
          info(`Loaded server extensions from ${ext}`);
        }
      } catch (err) {
        info(`Failed to load ${ext}: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }
  }
  unregisterTsx?.();

  const server = createServer({
    config,
    db: db as any,
    capabilities,
    entities,
    events,
    consumers,
    flows,
    promptRegistry,
    host,
    port,
    onRoutesRegistered,
    resolveAiOverrides,
    onCapabilityError,
    ...(process.env.TRUST_PROXY && {
      trustProxy: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY,
    }),
  });

  // Graceful shutdown handler
  let shuttingDown = false;
  let workerPool: WorkerPool | undefined;

  // Start worker pool if flows with triggers exist
  if (flows.getAll().some((f) => f.trigger?.event)) {
    const queue = createInMemoryQueue();

    // Build AI service for worker
    let workerAiService: AIService | undefined;
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
      };
      workerAiService = createAIService(workerAiServiceConfig);
      if (resolveAiOverrides) {
        workerAiService = wrapAIServiceWithDynamicOverrides(
          workerAiService,
          workerAiServiceConfig,
          resolveAiOverrides,
          db as any,
        );
      }
    } else if (config.ai) {
      const adapter = createProviderAdapter(config.ai.provider, config.ai);
      const costTracker = createCostTracker({
        maxTokensPerRequest: config.ai.maxTokensPerRequest,
        dailyCostLimit: config.ai.dailyCostLimit,
      });
      workerAiService = createAIService(
        singleProviderConfig(adapter, { costTracker, promptRegistry }),
      );
    }

    // Build step executor deps
    const stepDeps: StepExecutorDeps = {
      executeCapability: async (capabilityName, ctx, input) => {
        const capability = capabilities.get(capabilityName);
        if (!capability) {
          return {
            success: false,
            error: { code: 'not_found', message: `Capability "${capabilityName}" not found` },
          };
        }
        return executeCapability(capability, ctx, input);
      },
      evaluateCondition: (expression, state) => {
        try {
          const stateObj = state && typeof state === 'object' ? state : {};
          const fn = new Function('state', `return Boolean(${expression})`);
          return fn(stateObj);
        } catch {
          return false;
        }
      },
    };

    workerPool = createWorkerPool({
      config,
      db: db as any,
      queue,
      consumers,
      flows,
      stepDeps,
      aiService: workerAiService,
      createDataService: (auth) => {
        const effectiveAuth = auth ?? {
          userId: 'system-flow-runner',
          roles: ['system'],
          scopes: [],
          provider: 'worker',
        };
        return entities.createDataService({
          db: db as any,
          auth: effectiveAuth,
          bypassTenantScope: !effectiveAuth.tenantId,
        });
      },
      eventRegistry: events,
      onFlowError,
    });

    await workerPool.start();
    info(
      `Worker pool started (${flows.getAll().filter((f) => f.trigger?.event).length} event-triggered flows)`,
    );
  }

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('Graceful shutdown initiated...');
    if (workerPool) {
      await workerPool.stop();
      info('Worker pool stopped');
    }
    await server.stop();
    info('Server stopped');
  };

  const onSignal = () => {
    void shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Start listening
  const address = await server.start();
  info(`Server listening on ${address}`);
  info(`Health: ${serverUrl}/health`);
  info(`Ready: ${serverUrl}/ready`);

  return { server, shutdown };
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start production server')
    .option('-p, --port <port>', 'Server port', '3000')
    .option('-H, --host <host>', 'Server host', '0.0.0.0')
    .action(async (opts: StartOptions) => {
      try {
        await startProductionServer(opts);
      } catch (err) {
        logError(
          `Failed to start production server: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
