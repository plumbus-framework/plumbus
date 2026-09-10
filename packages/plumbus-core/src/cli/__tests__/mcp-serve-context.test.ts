import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRuntimeQueues, createMcpAuthAdapter } = vi.hoisted(() => ({
  resolveRuntimeQueues: vi.fn(),
  createMcpAuthAdapter: vi.fn(),
}));

vi.mock('@plumbus/mcp', () => ({ createMcpAuthAdapter }));

vi.mock('../../runtime/queue-factory.js', () => ({
  resolveRuntimeQueues,
}));

vi.mock('../discover.js', () => ({
  discoverResources: vi.fn(async () => ({
    capabilities: [],
    entities: [],
    flows: [],
    events: [],
    prompts: [],
    translations: [],
  })),
}));

vi.mock('../../config/loader.js', () => ({ loadConfig: vi.fn() }));

vi.mock('../../data/connection.js', () => ({
  resolveDatabaseConnection: vi.fn(async () => ({
    db: {},
    sql: null,
  })),
  closeDatabaseConnection: vi.fn(async () => {}),
}));

import { createExecutionContext } from '../../execution/context-factory.js';
import { signJwt } from '../../auth/index.js';
import { loadConfig } from '../../config/index.js';
import { resolveDatabaseConnection } from '../../data/connection.js';
import { discoverResources } from '../discover.js';
import { buildMcpServeContext } from '../mcp-serve-context.js';

const { loadConfig: realLoadConfig } =
  await vi.importActual<typeof import('../../config/loader.js')>('../../config/loader.js');

beforeEach(() => {
  vi.mocked(loadConfig)
    .mockReset()
    .mockImplementation((options) => realLoadConfig({ ...options, env: {} }));
  vi.mocked(resolveDatabaseConnection).mockClear();
  vi.mocked(discoverResources).mockClear();
  createMcpAuthAdapter.mockReset();
});

describe('buildMcpServeContext authentication', () => {
  const secret = 'mcp-test-signing-secret-at-least-32-characters';
  const placeholder = 'development-secret-placeholder-32chars-min';

  beforeEach(() => {
    resolveRuntimeQueues.mockReset().mockResolvedValue({
      jobs: { publish: vi.fn() },
      isDurable: false,
      close: vi.fn(async () => {}),
    });
  });

  it.each([
    { NODE_ENV: 'production' },
    { PLUMBUS_ENV: 'production', NODE_ENV: 'development' },
    { PLUMBUS_ENV: 'staging', NODE_ENV: 'development' },
    { PLUMBUS_ENV: 'unexpected' },
  ])('rejects unconfigured authentication before acquiring resources: %j', async (env) => {
    vi.mocked(loadConfig).mockImplementation((options) => realLoadConfig({ ...options, env }));

    await expect(buildMcpServeContext()).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('MCP serve requires mcp.agents or an explicit AUTH_SECRET'),
    });
    expect(discoverResources).not.toHaveBeenCalled();
    expect(resolveDatabaseConnection).not.toHaveBeenCalled();
    expect(resolveRuntimeQueues).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'short-secret',
    ' '.repeat(40),
    'short'.padEnd(40),
    placeholder,
    ` ${placeholder} `,
  ])('rejects invalid production secret %j', async (authSecret) => {
    vi.mocked(loadConfig).mockImplementation((options) =>
      realLoadConfig({ ...options, env: { NODE_ENV: 'production', AUTH_SECRET: authSecret } }),
    );

    await expect(buildMcpServeContext()).rejects.toMatchObject({ code: 'validation' });
    expect(resolveDatabaseConnection).not.toHaveBeenCalled();
    expect(resolveRuntimeQueues).not.toHaveBeenCalled();
  });

  it('does not authenticate forged admin JWTs in anonymous development mode', async () => {
    const ctx = await buildMcpServeContext();
    const forgedToken = signJwt({
      secret: placeholder,
      sub: 'attacker',
      roles: ['admin', 'system'],
      tenantId: 'victim-tenant',
    });

    expect(ctx.config.environment).toBe('development');
    await expect(
      ctx.routeConfig.authAdapter.authenticate(`Bearer ${forgedToken}`),
    ).resolves.toBeNull();
    await expect(ctx.routeConfig.authAdapter.authenticate(undefined)).resolves.toBeNull();
  });

  it('honors PLUMBUS_ENV precedence and verifies explicit JWT credentials', async () => {
    vi.mocked(loadConfig).mockImplementation((options) =>
      realLoadConfig({
        ...options,
        env: { NODE_ENV: 'development', PLUMBUS_ENV: 'production', AUTH_SECRET: secret },
      }),
    );
    const ctx = await buildMcpServeContext();
    const token = signJwt({ secret, sub: 'operator', roles: ['admin'], tenantId: 'tenant-1' });
    const forgedToken = signJwt({ secret: placeholder, sub: 'attacker', roles: ['admin'] });

    expect(ctx.config.environment).toBe('production');
    await expect(
      ctx.routeConfig.authAdapter.authenticate(`Bearer ${token}`),
    ).resolves.toMatchObject({
      userId: 'operator',
      roles: ['admin'],
      tenantId: 'tenant-1',
      provider: 'jwt',
    });
    await expect(
      ctx.routeConfig.authAdapter.authenticate(`Bearer ${forgedToken}`),
    ).resolves.toBeNull();
    await expect(ctx.routeConfig.authAdapter.authenticate(undefined)).resolves.toBeNull();
  });

  it('prefers configured agents without requiring a JWT secret in production', async () => {
    const agents = { 'agent-token': { serviceAccountId: 'agent', scopes: ['billing:read'] } };
    const adapter = { authenticate: vi.fn(async () => null) };
    createMcpAuthAdapter.mockReturnValue(adapter);
    vi.mocked(loadConfig).mockReturnValue({
      ...realLoadConfig({ env: { NODE_ENV: 'production' } }),
      mcp: { agents },
    });

    const ctx = await buildMcpServeContext();

    expect(createMcpAuthAdapter).toHaveBeenCalledWith({
      agents,
      envToken: process.env.PLUMBUS_MCP_TOKEN,
    });
    expect(ctx.routeConfig.authAdapter).toBe(adapter);
  });
});

describe('buildMcpServeContext jobQueue wiring', () => {
  beforeEach(() => {
    resolveRuntimeQueues.mockReset();
  });

  it('omits jobQueue when queues are not durable', async () => {
    const close = vi.fn(async () => {});
    resolveRuntimeQueues.mockResolvedValue({
      jobs: { publish: vi.fn() },
      isDurable: false,
      close,
    });

    const ctx = await buildMcpServeContext();

    expect(ctx.jobQueue).toBeUndefined();
    expect(resolveRuntimeQueues).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'development' }),
    );
    expect(resolveRuntimeQueues.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('passes jobQueue when queues are durable (Redis)', async () => {
    const jobsQueue = { publish: vi.fn() };
    resolveRuntimeQueues.mockResolvedValue({
      jobs: jobsQueue,
      isDurable: true,
      close: vi.fn(async () => {}),
    });

    const ctx = await buildMcpServeContext();

    expect(ctx.jobQueue).toBe(jobsQueue);
  });
});

describe('buildMcpServeContext capability invoke wiring', () => {
  beforeEach(() => {
    resolveRuntimeQueues.mockReset();
    resolveRuntimeQueues.mockResolvedValue({
      jobs: { publish: vi.fn() },
      isDurable: false,
      close: vi.fn(async () => {}),
    });
  });

  it('wires buildCapabilityRuntimeDeps into createDependencies', async () => {
    const ctx = await buildMcpServeContext();
    const deps = ctx.routeConfig.createDependencies({
      userId: 'u1',
      roles: [],
      scopes: [],
      provider: 'test',
    });
    const executionCtx = createExecutionContext(deps);

    expect(deps.invokeCapability).toBeTypeOf('function');
    expect(deps.resolveCapability).toBeTypeOf('function');
    expect(deps.invocationEmitScope).toBeDefined();
    expect(executionCtx.__runtime?.invokeCapability).toBeTypeOf('function');
  });
});
