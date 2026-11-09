import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthAdapter } from '../../auth/adapter.js';

const getById = vi.fn();
vi.mock('../service.js', () => ({
  createJobService: () => ({ getById }),
}));

const { registerJobStatusRoute, resolveJobAccess } = await import('../routes.js');

function jobRecord(overrides: { tenantId?: string | null; ownerUserId?: string } = {}) {
  return {
    id: 'job-1',
    status: 'completed',
    capabilityDomain: 'billing',
    capabilityName: 'exportInvoices',
    source: 'http',
    tenantId: overrides.tenantId === undefined ? 'tenant-a' : overrides.tenantId,
    authSnapshotJson: { userId: overrides.ownerUserId ?? 'owner-1' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    startedAt: null,
    completedAt: null,
    outputJson: { secret: 'tenant-a-data' },
    errorJson: null,
  };
}

type Caller = { userId: string; tenantId?: string; roles: string[] };

async function callRoute(caller: Caller) {
  const app = Fastify();
  const authAdapter = {
    authenticate: vi.fn().mockResolvedValue(caller),
  } as unknown as AuthAdapter;
  registerJobStatusRoute(app, { db: {} as never, authAdapter });
  const res = await app.inject({
    method: 'GET',
    url: '/api/jobs/job-1',
    headers: { authorization: 'Bearer x' },
  });
  await app.close();
  return { status: res.statusCode, body: res.json() };
}

describe('GET /api/jobs/:jobId tenant isolation', () => {
  beforeEach(() => getById.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('returns the job to its owner in the same tenant', async () => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'owner-1', tenantId: 'tenant-a', roles: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.output).toEqual({ secret: 'tenant-a-data' });
  });

  it('returns the job to a same-tenant admin', async () => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'admin-a', tenantId: 'tenant-a', roles: ['admin'] });
    expect(res.status).toBe(200);
  });

  it.each([
    ['admin'],
    ['system'],
  ])('hides another tenant job from a %s with a tenantId, as not found', async (role) => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'admin-b', tenantId: 'tenant-b', roles: [role] });
    getById.mockResolvedValue(undefined);
    const missing = await callRoute({ userId: 'admin-b', tenantId: 'tenant-b', roles: [role] });
    expect(res.status).toBe(404);
    expect(res).toEqual(missing);
    expect(JSON.stringify(res.body)).not.toContain('tenant-a-data');
  });

  it('hides another tenant job from its owner user id in a different tenant', async () => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'owner-1', tenantId: 'tenant-b', roles: [] });
    expect(res.status).toBe(404);
  });

  it('fails closed for an owner without tenantId on a tenant job', async () => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'owner-1', roles: [] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it.each([
    ['admin'],
    ['system'],
  ])('keeps global access for a %s without tenantId (platform staff)', async (role) => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'staff', roles: [role] });
    expect(res.status).toBe(200);
    expect(res.body.data.output).toEqual({ secret: 'tenant-a-data' });
  });

  it('forbids a same-tenant non-owner without admin role', async () => {
    getById.mockResolvedValue(jobRecord());
    const res = await callRoute({ userId: 'other', tenantId: 'tenant-a', roles: ['user'] });
    expect(res.status).toBe(403);
  });
});

describe('resolveJobAccess on jobs without a tenant', () => {
  const job = { tenantId: null, ownerUserId: 'owner-1' };

  it('allows the owner', () => {
    expect(resolveJobAccess(job, { userId: 'owner-1', roles: [] })).toBe('allowed');
    expect(resolveJobAccess(job, { userId: 'owner-1', tenantId: 't', roles: [] })).toBe('allowed');
  });

  it('allows a tenant-less admin and hides it from a tenant admin', () => {
    expect(resolveJobAccess(job, { userId: 'a', roles: ['admin'] })).toBe('allowed');
    expect(resolveJobAccess(job, { userId: 'a', tenantId: 't', roles: ['admin'] })).toBe(
      'not_found',
    );
  });

  it('forbids a tenant-less non-owner without admin role', () => {
    expect(resolveJobAccess(job, { userId: 'x', roles: [] })).toBe('forbidden');
  });
});
