import { describe, expect, it, vi } from 'vitest';
import { AISecurityBlockedError } from '../../errors/index.js';
import { loadConfig } from '../../config/loader.js';
import { defineEntity } from '../../define/defineEntity.js';
import { field } from '../../fields/index.js';
import { createExecutionContext } from '../../execution/context-factory.js';
import { buildResourceContext } from '../resource-context.js';

vi.mock('../../data/connection.js', () => ({
  resolveDatabaseConnection: async () => ({ db: {} }),
  closeDatabaseConnection: async () => {},
}));

describe('voice classification-only entities', () => {
  it('blocks classified fields without creating an unused data repository', async () => {
    const active = defineEntity({
      name: 'Interview',
      fields: { id: field.id(), activeSecret: field.string({ classification: 'sensitive' }) },
    });
    const classified = defineEntity({
      name: 'Secret',
      fields: { passwordHash: field.string({ classification: 'sensitive' }) },
    });
    const runtime = await buildResourceContext({
      config: loadConfig({
        env: {
          AI_DEFAULT_PROVIDER: 'openai',
          AI_OPENAI_API_KEY: 'test-only-key',
          AI_DEFAULT_MODEL: 'gpt-4.1',
          AI_SECURITY_MODE: 'block',
          AI_SECURITY_REDACT_THRESHOLD: 'sensitive',
        },
      }),
      resources: {
        entities: [active],
        capabilities: [],
        prompts: [],
        events: [],
        flows: [],
        translations: [],
        schemas: {},
      },
      securityEntities: [classified],
      extensions: {},
      authAdapter: { authenticate: async () => null },
      component: 'voice',
      openQueues: false,
      enableFlows: false,
    });
    const deps = runtime.routeConfig.createDependencies({
      userId: 'u',
      tenantId: 't',
      roles: [],
      scopes: [],
      provider: 'test',
    });
    expect(Object.keys(deps.data ?? {})).toEqual(['Interview']);
    const ctx = createExecutionContext(deps);
    await expect(
      ctx.ai.generate({ prompt: 'test', input: { passwordHash: 'do-not-send' } }),
    ).rejects.toBeInstanceOf(AISecurityBlockedError);
    await expect(
      ctx.ai.generate({ prompt: 'test', input: { activeSecret: 'also-blocked' } }),
    ).rejects.toBeInstanceOf(AISecurityBlockedError);
    await runtime.closeDb();
  });
});
