import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionProviderAdapter, DecisionRuntimeConfig } from '@plumbus/ai-decision/types';
import { defineDecision } from '@plumbus/ai-decision';
import { buildWorkerAiService } from '../bootstrap.js';
import { loadServerExtensions } from '../load-extensions.js';
import { createServer, wrapAIServiceWithDynamicOverrides } from '../../server/bootstrap.js';
import { createAIService } from '../../ai/index.js';
import { EntityRegistry } from '../../data/index.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import { createTestContext } from '../../testing/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { AIService } from '../../types/context.js';

const questions = { p: { type: 'probability', instructions: '?' } } as const;
function decisions(): DecisionRuntimeConfig {
  return {
    defaultProvider: 'stub',
    budget: { dailyCostLimit: 1 },
    providers: {
      stub: {
        name: 'stub',
        async decide() {
          return {
            provider: 'stub',
            model: 'actual',
            answers: { p: { type: 'probability', probability: 0.5 } },
            usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
            cost: 0.1,
            costAvailable: true,
            latencyMs: 1,
          };
        },
      } as DecisionProviderAdapter,
    },
  };
}
const baseConfig: PlumbusConfig = {
  environment: 'development',
  database: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: '' },
  queue: { host: 'localhost', port: 6379 },
  auth: { provider: 'jwt', secret: 'synthetic-test-secret-at-least-32-characters' },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('decision runtime wiring', () => {
  it.each([
    'decision-only',
    'legacy-text',
    'multi-text',
  ] as const)('records worker calls for %s configuration', async (mode) => {
    const config = structuredClone(baseConfig);
    if (mode === 'legacy-text') config.ai = { provider: 'openai', apiKey: 'synthetic' };
    if (mode === 'multi-text')
      config.aiProviders = {
        defaultProvider: 'openai',
        providers: { openai: { provider: 'openai', apiKey: 'synthetic' } },
      };
    const db = {} as never;
    const hook = vi.fn();
    const ai = buildWorkerAiService({ config, db, decisions: decisions(), onAICostRecorded: hook });
    expect(ai).toBeDefined();
    const ctx = createTestContext({
      ai,
      auth: { tenantId: 'worker-tenant', userId: 'worker-user' },
    });
    await ctx.ai.decide({ state: 'x', questions, costContext: { projectId: 'project' } });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'decide',
        tenantId: 'worker-tenant',
        actor: 'worker-user',
        cost: 0.1,
      }),
      { projectId: 'project' },
      db,
    );
  });

  it('keeps scoped decision calls and feature flags through dynamic prompt wrappers', async () => {
    const hook = vi.fn();
    const config = {
      providers: {},
      defaultProvider: '',
      decisions: decisions(),
      onAICostRecorded: hook,
    };
    const wrapped = wrapAIServiceWithDynamicOverrides(
      createAIService(config),
      config,
      async () => ({}),
      {} as never,
    );
    expect(wrapped.features?.typedDecisions).toBe(true);
    const ctx = createTestContext({ ai: wrapped, auth: { tenantId: 'wrapped' } });
    await ctx.ai.decide({ state: 'x', questions });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'wrapped', operation: 'decide' }),
      undefined,
    );
  });

  it('wires decision-only HTTP contexts to the same database-aware ledger hook', async () => {
    const db = {} as never;
    const hook = vi.fn();
    let ai: AIService | undefined;
    const server = createServer({
      config: baseConfig,
      db,
      decisions: decisions(),
      capabilities: new CapabilityRegistry(),
      entities: new EntityRegistry(),
      events: new EventRegistry(),
      consumers: new ConsumerRegistry(),
      flows: new FlowRegistry(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onAICostRecorded: hook,
      onRoutesRegistered(_app, routes) {
        const deps = routes.createDependencies({
          userId: 'http-user',
          tenantId: 'http-tenant',
          roles: [],
          scopes: [],
          provider: 'test',
        });
        ai = deps.ai;
      },
    });
    try {
      expect(ai).toBeDefined();
      const ctx = createTestContext({ ai, auth: { userId: 'http-user', tenantId: 'http-tenant' } });
      await ctx.ai.decide({ state: 'x', questions });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'http-user',
          tenantId: 'http-tenant',
          operation: 'decide',
        }),
        undefined,
        db,
      );
    } finally {
      await server.stop();
    }
  });

  it('loads explicit registration with ESM and includes discovered named definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plumbus-decision-wiring-'));
    directories.push(root);
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app', 'server.js'),
      "export const decisions = { providers: {}, defaultProvider: 'stub' };\n",
    );
    const definition = defineDecision({ name: 'test', questions });
    const extensions = await loadServerExtensions(root, [definition]);
    expect(extensions.decisions).toMatchObject({
      defaultProvider: 'stub',
      definitions: [definition],
    });
  });
});
