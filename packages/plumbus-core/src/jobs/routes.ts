import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import type { AuthAdapter } from '../auth/adapter.js';
import type { RequestAuthenticator } from '../auth/http-authentication.js';
import {
  authenticationFailureToHttp,
  buildAuthenticationRequest,
} from '../api/authentication-http.js';
import { createJobService } from './service.js';

export interface JobStatusRouteConfig {
  db: PostgresJsDatabase;
  authAdapter: AuthAdapter;
  requestAuthenticator?: RequestAuthenticator;
}

export type JobAccessDecision = 'allowed' | 'forbidden' | 'not_found';

/**
 * Decide whether a caller may read a job's status, output and error.
 *
 * - A caller with a tenantId only ever sees jobs of that tenant, whatever their
 *   role. Jobs of another tenant answer as not found.
 * - A caller without a tenantId sees a tenant-scoped job only when they hold the
 *   `admin` or `system` role (platform staff). Ownership alone fails closed.
 * - Jobs without a tenant are visible to their owner, and to `admin`/`system`
 *   callers that have no tenantId.
 * - Within a tenant, only the job's owner or an `admin`/`system` caller may read it.
 */
export function resolveJobAccess(
  job: { tenantId?: string | null; ownerUserId?: string | null },
  caller: { userId: string; tenantId?: string | null; roles: readonly string[] },
): JobAccessDecision {
  const isOwner = !!job.ownerUserId && job.ownerUserId === caller.userId;
  const isAdmin = caller.roles.includes('admin') || caller.roles.includes('system');
  const jobTenant = job.tenantId || null;
  const callerTenant = caller.tenantId || null;

  if (jobTenant) {
    if (callerTenant) {
      if (callerTenant !== jobTenant) return 'not_found';
      return isOwner || isAdmin ? 'allowed' : 'forbidden';
    }
    // Tenant-less caller on a tenant job: only platform staff.
    return isAdmin ? 'allowed' : 'not_found';
  }

  // Job without a tenant.
  if (isOwner) return 'allowed';
  if (callerTenant) return 'not_found';
  return isAdmin ? 'allowed' : 'forbidden';
}

/** Register GET /api/jobs/:jobId — additive job status endpoint. */
export function registerJobStatusRoute(app: FastifyInstance, config: JobStatusRouteConfig): void {
  const jobs = createJobService(config.db);

  app.get('/api/jobs/:jobId', async (request, reply) => {
    let auth: Awaited<ReturnType<AuthAdapter['authenticate']>>;

    if (!config.requestAuthenticator) {
      const authHeader = request.headers.authorization;
      auth = await config.authAdapter.authenticate(authHeader);
      if (!auth?.userId) {
        reply.status(401);
        return { error: { code: 'unauthorized', message: 'Authentication required' } };
      }
    } else {
      const authResult = await config.requestAuthenticator.authenticate(
        buildAuthenticationRequest(request),
      );

      if (authResult.status === 'authenticated') {
        auth = authResult.auth;
      } else if (authResult.status === 'anonymous') {
        if (authResult.clearCookieHeader) {
          reply.header('set-cookie', authResult.clearCookieHeader);
        }
        reply.status(401);
        return { error: { code: 'unauthorized', message: 'Authentication required' } };
      } else {
        const httpFailure = authenticationFailureToHttp(authResult);
        reply.status(httpFailure.statusCode);
        if (httpFailure.headers) {
          for (const [key, value] of Object.entries(httpFailure.headers)) {
            reply.header(key, value);
          }
        }
        return httpFailure.body;
      }

      if (!auth.userId) {
        reply.status(401);
        return { error: { code: 'unauthorized', message: 'Authentication required' } };
      }
    }

    const { jobId } = request.params as { jobId: string };
    const record = await jobs.getById(jobId);
    if (!record) {
      reply.status(404);
      return { error: { code: 'not_found', message: 'Job not found' } };
    }

    const access = resolveJobAccess(
      { tenantId: record.tenantId, ownerUserId: record.authSnapshotJson?.userId },
      { userId: auth.userId, tenantId: auth.tenantId, roles: auth.roles },
    );

    if (access === 'not_found') {
      // Cross-tenant (or tenant-less caller on a tenant job): answer exactly as
      // if the job did not exist so job ids cannot be probed across tenants.
      reply.status(404);
      return { error: { code: 'not_found', message: 'Job not found' } };
    }
    if (access === 'forbidden') {
      reply.status(403);
      return { error: { code: 'forbidden', message: 'Access denied' } };
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
