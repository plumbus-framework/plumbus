// ── plumbus start ──
// Production server command: starts API server without watchers or dev tooling.
// Forces production environment and production-safe defaults.

import type { Command } from 'commander';
import { PromptRegistry } from '../../ai/prompt-registry.js';
import { loadConfig, validateConfig } from '../../config/loader.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { PlumbusServer } from '../../server/bootstrap.js';
import { createServer } from '../../server/bootstrap.js';
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
