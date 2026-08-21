import { describe, expect, it, vi } from 'vitest';
import { registerAllRoutes } from '../../api/route-generator.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { AuthContext } from '../../types/security.js';
import { createServer, type ServerConfig } from '../../server/bootstrap.js';
import { ActionRiskTier } from '../action-risk.js';
import { hostApprovalRuntimeExtras } from '../host-runtime.js';
import { createMemoryApprovalStore } from '../memory-store.js';
import { createApprovalService } from '../service.js';

vi.mock('../../api/route-generator.js', () => ({
  registerAllRoutes: vi.fn(),
}));

vi.mock('../../ai/ai-service.js', () => ({
  createAIService: vi.fn(() => ({})),
  singleProviderConfig: vi.fn(),
}));

vi.mock('../../ai/provider.js', () => ({
  createProviderAdapter: vi.fn(() => ({ name: 'mock' })),
}));

vi.mock('../../ai/cost-tracker.js', () => ({
  createCostTracker: vi.fn(() => ({ checkBudget: () => ({ allowed: true }), record: vi.fn() })),
}));

vi.mock('../../auth/adapter.js', () => ({
  createJwtAdapter: vi.fn(() => ({ authenticate: vi.fn() })),
}));

vi.mock('fastify', () => {
  const app = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    register: vi.fn(),
    addHook: vi.fn(),
    setErrorHandler: vi.fn(),
    listen: vi.fn(),
    close: vi.fn(),
  };
  return { default: vi.fn(() => app) };
});

function makeConfig(): PlumbusConfig {
  return {
    environment: 'development',
    database: {
      host: 'localhost',
      port: Number(process.env.DB_PORT ?? process.env.PGPORT ?? process.env.PLUMBUS_TEST_PG_PORT),
      database: 'plumbus_dev',
      user: 'postgres',
      password: 'postgres',
    },
    queue: {
      host: 'localhost',
      port: Number(process.env.REDIS_PORT ?? process.env.PLUMBUS_REDIS_PORT),
      prefix: 'plumbus:dev',
    },
    auth: { provider: 'jwt', secret: 'test-secret-placeholder-32chars-min' },
  };
}

function makeServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    config: makeConfig(),
    db: {} as ServerConfig['db'],
    capabilities: new CapabilityRegistry(),
    entities: new EntityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    ...overrides,
  };
}

const auth: AuthContext = {
  userId: 'user-1',
  roles: ['admin'],
  scopes: [],
  provider: 'test',
};

describe('hostApprovalRuntimeExtras', () => {
  it('returns nothing when the host does not opt in', () => {
    expect(hostApprovalRuntimeExtras(undefined)).toEqual({});
    expect(hostApprovalRuntimeExtras({})).toEqual({});
  });

  it('passes through a host-supplied approval service', () => {
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    expect(hostApprovalRuntimeExtras({ approvals }).approvals).toBe(approvals);
  });
});

describe('createServer approval opt-in', () => {
  it('does not attach approvals when the host omits the option', () => {
    createServer(makeServerConfig());
    const routeConfig = vi.mocked(registerAllRoutes).mock.calls[0][2];
    const deps = routeConfig.createDependencies(auth);
    expect(deps.approvals).toBeUndefined();
    expect(deps.authorizationProvider).toBeUndefined();
  });

  it('wires the host approval service onto request dependencies', async () => {
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    createServer(makeServerConfig({ approvals }));
    const routeConfig = vi.mocked(registerAllRoutes).mock.calls.at(-1)?.[2];
    const deps = routeConfig?.createDependencies(auth);
    expect(deps?.approvals).toBe(approvals);
    expect(
      (
        await approvals.requestApproval({
          capabilityId: 'billing.refund',
          definitionVersion: '1',
          input: { amount: 1 },
          riskClass: ActionRiskTier.Consequential,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).state,
    ).toBe('pending');
  });
});
