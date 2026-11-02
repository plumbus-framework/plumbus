import { createRequire } from 'node:module';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

const require = createRequire(import.meta.url);

/** Keep HTTP dependencies out of processes that only import the SDK. */
export function createFastify(options: FastifyServerOptions): FastifyInstance {
  const fastify = require('fastify') as typeof import('fastify').default;
  return fastify(options);
}
