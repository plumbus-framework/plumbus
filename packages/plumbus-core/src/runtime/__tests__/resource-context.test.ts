import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../config/loader.js';
import { defineCapability } from '../../define/defineCapability.js';
import { defineEntity } from '../../define/defineEntity.js';
import { field } from '../../fields/index.js';
import { createExecutionContext } from '../../execution/context-factory.js';
import { executeCapability } from '../../execution/capability-executor.js';
import { buildResourceContext } from '../resource-context.js';

const mocks = vi.hoisted(() => ({
  buildAi: vi.fn(),
  closeDb: vi.fn(),
  queues: vi.fn(),
  db: { insert: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../bootstrap.js', () => ({ buildWorkerAiService: mocks.buildAi }));
vi.mock('../queue-factory.js', () => ({ resolveRuntimeQueues: mocks.queues }));
vi.mock('../../data/connection.js', () => ({
  resolveDatabaseConnection: async () => ({ db: mocks.db }),
  closeDatabaseConnection: mocks.closeDb,
}));

const privateCapability = defineCapability({
  name: 'privateTurn',
  domain: 'interview',
  kind: 'query',
  input: z.object({}),
  output: z.string(),
  effects: { data: [], events: [], external: [], ai: false },
  access: { roles: ['interviewer'] },
  handler: async () => 'ok',
});
const entity = defineEntity({
  name: 'Interview',
  description: 'Interview record',
  tenantField: 'tenantId',
  fields: { id: field.id(), tenantId: field.string(), notes: field.string() },
});
function options() {
  return {
    config: loadConfig({ env: {} }),
    resources: {
      capabilities: [privateCapability],
      entities: [entity],
      events: [],
      prompts: [],
      flows: [],
      translations: [],
      schemas: {},
    },
    extensions: {},
    authAdapter: { authenticate: async () => null },
    component: 'voice-capability',
    openQueues: false,
    enableFlows: false,
  };
}
const auth = { userId: 'user', tenantId: 'tenant', roles: [], scopes: [], provider: 'livekit' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildAi.mockReturnValue(undefined);
  mocks.db.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
  });
});

describe('scoped resource context', () => {
  it('retains identity, data, audit, transactional events and capability authorization without opening queues', async () => {
    const runtime = await buildResourceContext(options());
    const deps = runtime.routeConfig.createDependencies(auth);
    expect(deps.auth).toBe(auth);
    expect(deps.data?.Interview).toBeDefined();
    expect(deps.audit).toBeDefined();
    expect(deps.events?.emit).toBeTypeOf('function');
    expect(deps.withTransaction).toBeTypeOf('function');
    expect(deps.resolveCapability?.('interview.privateTurn')).toBe(privateCapability);
    expect(deps.resolveCapability?.('payments.charge')).toBeUndefined();
    expect(deps.flows).toBeUndefined();
    const result = await executeCapability(privateCapability, createExecutionContext(deps), {});
    expect(result).toMatchObject({ success: false, error: { code: 'forbidden' } });
    expect(mocks.queues).not.toHaveBeenCalled();
    await runtime.closeQueues();
    await runtime.closeDb();
    expect(mocks.closeDb).toHaveBeenCalledOnce();
  });

  it('passes cost hooks, model overrides, decision providers and strict outputs to the governed AI service', async () => {
    const extensions = {
      onAICostRecorded: vi.fn(),
      resolveAiOverrides: vi.fn(),
      enableStrictStructuredOutputs: true,
      decisions: { providers: {} },
    };
    await buildResourceContext({ ...options(), extensions });
    expect(mocks.buildAi).toHaveBeenCalledWith(
      expect.objectContaining({
        ...extensions,
        db: mocks.db,
        promptRegistry: expect.anything(),
        entities: expect.anything(),
      }),
    );
  });

  it('closes acquired connections when AI initialization fails', async () => {
    mocks.buildAi.mockImplementationOnce(() => {
      throw new Error('invalid AI config');
    });
    await expect(buildResourceContext(options())).rejects.toThrow('invalid AI config');
    expect(mocks.closeDb).toHaveBeenCalledOnce();
  });

  it('preserves MCP durable queues and flow services when requested', async () => {
    const close = vi.fn();
    const jobs = {};
    mocks.queues.mockResolvedValueOnce({ isDurable: true, jobs, close });
    const runtime = await buildResourceContext({
      ...options(),
      openQueues: true,
      enableFlows: true,
    });
    expect(runtime.jobQueue).toBe(jobs);
    expect(runtime.routeConfig.createDependencies(auth).flows?.start).toBeTypeOf('function');
    await runtime.closeQueues();
    expect(close).toHaveBeenCalledOnce();
  });
});
