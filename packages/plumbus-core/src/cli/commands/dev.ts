// ── plumbus dev ──
// Development server command: starts API server + workers
// with auto-reload awareness and dev-friendly defaults.

import type { Command } from 'commander';
import { loadConfig, validateConfig } from '../../config/loader.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { PlumbusServer } from '../../server/bootstrap.js';
import { createServer } from '../../server/bootstrap.js';
import { discoverResources } from '../discover.js';
import { info, error as logError, warn } from '../utils.js';

export interface DevOptions {
  port?: string;
  host?: string;
  json?: boolean;
}

/**
 * Run the development server config validation (sync).
 *
 * This:
 * 1. Loads config from env variables with dev defaults
 * 2. Validates the config
 * 3. Prints server info
 *
 * Returns config and validation result. Call startDevServer() to start the actual server.
 */
export function runDev(options: DevOptions): {
  config: ReturnType<typeof loadConfig>;
  validation: ReturnType<typeof validateConfig>;
  serverUrl: string;
} {
  const config = loadConfig({ environment: 'development' });
  const validation = validateConfig(config);

  const port = parseInt(options.port ?? '3000', 10);
  const host = options.host ?? 'localhost';
  const serverUrl = `http://${host}:${port}`;

  if (!options.json) {
    info('Plumbus Development Server');
    info(`Environment: ${config.environment}`);
    info(`Server URL: ${serverUrl}`);
    info(`Database: ${config.database.host}:${config.database.port}/${config.database.database}`);
    info(`Queue: ${config.queue.host}:${config.queue.port}`);

    if (config.ai) {
      info(`AI Provider: ${config.ai.provider}`);
    } else {
      warn('AI provider not configured (set AI_PROVIDER and AI_API_KEY)');
    }

    if (validation.errors.length > 0) {
      logError('Config errors:');
      for (const err of validation.errors) {
        logError(`  - ${err}`);
      }
    }

    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        warn(w);
      }
    }

    if (validation.valid) {
      info('Config valid — ready to start');
    }
  }

  return { config, validation, serverUrl };
}

/**
 * Start the actual development server (async).
 * Discovers resources from app/, populates registries, connects to DB,
 * and starts the Fastify server. Sets up graceful shutdown on SIGINT/SIGTERM.
 */
export async function startDevServer(options: DevOptions & { db?: unknown }): Promise<{
  server: PlumbusServer;
  shutdown: () => Promise<void>;
}> {
  const { config, validation, serverUrl } = runDev(options);

  if (!validation.valid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`);
  }

  const port = parseInt(options.port ?? '3000', 10);
  const host = options.host ?? '0.0.0.0';

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

  // Connect to database (caller can override via options.db)
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

  const server = createServer({
    config,
    db: db as any,
    capabilities,
    entities,
    events,
    consumers,
    flows,
    host,
    port,
  });

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('Graceful shutdown initiated...');
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
  info(`Health check: ${serverUrl}/health`);
  info('Press Ctrl+C to stop');

  return { server, shutdown };
}

export function registerDevCommand(program: Command): void {
  program
    .command('dev')
    .description('Start development server with hot-reload')
    .option('-p, --port <port>', 'Server port', '3000')
    .option('-H, --host <host>', 'Server host', 'localhost')
    .option('--json', 'Output JSON')
    .action(async (opts: DevOptions) => {
      const result = runDev(opts);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              config: {
                environment: result.config.environment,
                database: `${result.config.database.host}:${result.config.database.port}/${result.config.database.database}`,
                queue: `${result.config.queue.host}:${result.config.queue.port}`,
                ai: result.config.ai?.provider ?? null,
              },
              validation: result.validation,
              serverUrl: result.serverUrl,
            },
            null,
            2,
          ),
        );
        return;
      }

      // Start the actual server if config is valid
      if (result.validation.valid) {
        try {
          await startDevServer(opts);
        } catch (err) {
          logError(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
          info('Ensure the database is running and config is correct.');
        }
      }
    });
}
