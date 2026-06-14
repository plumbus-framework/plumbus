// ── Worker Health / Metrics Server ──
// Lightweight HTTP endpoints for split worker processes.

import Fastify from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { createPlumbusMetrics } from '../observability/metrics.js';
import type { RuntimeQueues } from './queue-factory.js';
import type { WorkerPool } from '../worker/bootstrap.js';

export interface WorkerHealthServerConfig {
  port: number;
  host?: string;
  db: PostgresJsDatabase;
  queues?: RuntimeQueues;
  workerPool?: WorkerPool;
  metrics?: ReturnType<typeof createPlumbusMetrics>;
}

export interface WorkerHealthServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  metrics: ReturnType<typeof createPlumbusMetrics>;
}

export function createWorkerHealthServer(config: WorkerHealthServerConfig): WorkerHealthServer {
  const app = Fastify({ logger: false });
  const metrics = config.metrics ?? createPlumbusMetrics();
  const host = config.host ?? '0.0.0.0';

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_req, reply) => {
    try {
      await config.db.execute(sql`SELECT 1`);
      if (config.queues?.isDurable && config.queues.pingRedis) {
        await config.queues.pingRedis();
      }
      return { status: 'ready' };
    } catch (err) {
      reply.status(503);
      return {
        status: 'not_ready',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get('/metrics', async () => {
    return metrics.registry.serialize();
  });

  return {
    metrics,
    async start() {
      const address = await app.listen({ port: config.port, host });
      return typeof address === 'string' ? address : `http://${host}:${config.port}`;
    },
    async stop() {
      await app.close();
    },
  };
}
