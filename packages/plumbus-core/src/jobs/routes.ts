import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import type { AuthAdapter } from '../auth/adapter.js';
import { createJobService } from './service.js';

export interface JobStatusRouteConfig {
  db: PostgresJsDatabase;
  authAdapter: AuthAdapter;
}

/** Register GET /api/jobs/:jobId — additive job status endpoint. */
export function registerJobStatusRoute(app: FastifyInstance, config: JobStatusRouteConfig): void {
  const jobs = createJobService(config.db);

  app.get('/api/jobs/:jobId', async (request, reply) => {
    const authHeader = request.headers.authorization;
    const auth = await config.authAdapter.authenticate(authHeader);
    if (!auth?.userId) {
      reply.status(401);
      return { error: { code: 'unauthorized', message: 'Authentication required' } };
    }

    const { jobId } = request.params as { jobId: string };
    const record = await jobs.getById(jobId);
    if (!record) {
      reply.status(404);
      return { error: { code: 'not_found', message: 'Job not found' } };
    }

    const isOwner = record.authSnapshotJson?.userId === auth.userId;
    const isAdmin = auth.roles.includes('admin') || auth.roles.includes('system');
    const tenantMatch = !record.tenantId || !auth.tenantId || record.tenantId === auth.tenantId;

    if (!isOwner && !isAdmin) {
      reply.status(403);
      return { error: { code: 'forbidden', message: 'Access denied' } };
    }
    if (!tenantMatch && !isAdmin) {
      reply.status(403);
      return { error: { code: 'forbidden', message: 'Tenant mismatch' } };
    }

    return {
      data: {
        jobId: record.id,
        status: record.status,
        capability: { domain: record.capabilityDomain, name: record.capabilityName },
        source: record.source,
        createdAt: record.createdAt.toISOString(),
        startedAt: record.startedAt?.toISOString() ?? null,
        completedAt: record.completedAt?.toISOString() ?? null,
        output: record.outputJson ?? null,
        error: record.errorJson ?? null,
      },
    };
  });
}
