import { afterEach, describe, expect, it, vi } from 'vitest';

const mockClose = vi.fn(async () => {});
const mockDb = { execute: vi.fn() };

vi.mock('../data-plane-connection.js', () => ({
  openDataPlaneConnection: vi.fn(async () => ({ db: mockDb, close: mockClose })),
}));

vi.mock('../../data/migration.js', () => ({
  applyMigrations: vi.fn(async () => ({ applied: 2, tags: ['0001_init', '0002_add'] })),
}));

import { applyMigrations } from '../../data/migration.js';
import { openDataPlaneConnection } from '../data-plane-connection.js';
import {
  applyDataPlaneMigrations,
  DATA_PLANE_MIGRATE_APPLICATION_NAME,
} from '../data-plane-migrate.js';

describe('applyDataPlaneMigrations', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockClose.mockResolvedValue(undefined);
    vi.mocked(applyMigrations).mockResolvedValue({
      applied: 2,
      tags: ['0001_init', '0002_add'],
    });
  });

  const target = {
    host: 'db.example.test',
    database: 'tenant_alpha',
    user: 'tenant_alpha_owner',
    password: 'owner-secret',
  };

  it('opens the named database through the connection factory, applies, and closes', async () => {
    const result = await applyDataPlaneMigrations({
      target,
      migrationsFolder: '/tmp/drizzle',
    });

    expect(openDataPlaneConnection).toHaveBeenCalledWith({
      target,
      maxConnections: 1,
      applicationName: DATA_PLANE_MIGRATE_APPLICATION_NAME,
    });
    expect(applyMigrations).toHaveBeenCalledWith({
      db: mockDb,
      migrationsFolder: '/tmp/drizzle',
    });
    expect(mockClose).toHaveBeenCalledOnce();
    expect(result).toEqual({
      applied: 2,
      tags: ['0001_init', '0002_add'],
      database: 'tenant_alpha',
    });
  });

  it('closes the pool when apply fails', async () => {
    vi.mocked(applyMigrations).mockRejectedValueOnce(new Error('statement 1 failed'));

    await expect(
      applyDataPlaneMigrations({ target, migrationsFolder: '/tmp/drizzle' }),
    ).rejects.toThrow('statement 1 failed');

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('does not apply when the factory refuses the target', async () => {
    vi.mocked(openDataPlaneConnection).mockRejectedValueOnce(new Error('Could not open'));

    await expect(
      applyDataPlaneMigrations({ target, migrationsFolder: '/tmp/drizzle' }),
    ).rejects.toThrow('Could not open');

    expect(applyMigrations).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('omits database on the result when the target is a URL without an override', async () => {
    const result = await applyDataPlaneMigrations({
      target: { connectionString: 'postgres://owner@db.example.test/tenant_beta' },
      migrationsFolder: '/tmp/drizzle',
    });

    expect(result.applied).toBe(2);
    expect(result.database).toBeUndefined();
  });
});
