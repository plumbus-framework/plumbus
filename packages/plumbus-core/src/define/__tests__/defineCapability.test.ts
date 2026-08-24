import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../defineCapability.js';

describe('defineCapability', () => {
  const validConfig = () => ({
    name: 'getUser',
    kind: 'query' as const,
    domain: 'users',
    input: z.object({ userId: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
    effects: { data: ['User'], events: [], external: [], ai: false },
    handler: async (_ctx: any, input: z.infer<z.ZodObject<{ userId: z.ZodString }>>) => ({
      id: input.userId,
      name: 'Test User',
    }),
  });

  it('creates a valid capability contract', () => {
    const cap = defineCapability(validConfig());
    expect(cap.name).toBe('getUser');
    expect(cap.kind).toBe('query');
    expect(cap.domain).toBe('users');
    expect(cap.effects.ai).toBe(false);
    expect(typeof cap.handler).toBe('function');
  });

  it('freezes the returned contract', () => {
    const cap = defineCapability(validConfig());
    expect(Object.isFrozen(cap)).toBe(true);
  });

  it('accepts optional fields', () => {
    const cap = defineCapability({
      ...validConfig(),
      description: 'Fetches a user by ID',
      tags: ['user', 'read'],
      version: '1.0.0',
      owner: 'team-users',
      access: { roles: ['admin'], tenantScoped: true },
      audit: { event: 'user.fetched', includeInput: ['userId'] },
      explanation: { enabled: true, summary: 'Fetched user data' },
    });
    expect(cap.description).toBe('Fetches a user by ID');
    expect(cap.access?.roles).toEqual(['admin']);
    expect(cap.audit?.event).toBe('user.fetched');
  });

  it('accepts action-risk tiers', () => {
    const cap = defineCapability({
      ...validConfig(),
      riskTier: 'consequential',
    });
    expect(cap.riskTier).toBe('consequential');
  });

  it('rejects retired action-risk values', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        riskTier: 'sensitive-write' as 'consequential',
      }),
    ).toThrow('riskTier must be one of');
  });

  it('throws if name is missing', () => {
    expect(() => defineCapability({ ...validConfig(), name: '' })).toThrow('name is required');
  });

  it('throws if kind is missing', () => {
    expect(() => defineCapability({ ...validConfig(), kind: '' as any })).toThrow(
      'kind is required',
    );
  });

  it('throws if domain is missing', () => {
    expect(() => defineCapability({ ...validConfig(), domain: '' })).toThrow('domain is required');
  });

  it('throws if input is not a Zod schema', () => {
    expect(() => defineCapability({ ...validConfig(), input: {} as any })).toThrow(
      'input must be a Zod schema',
    );
  });

  it('throws if output is not a Zod schema', () => {
    expect(() => defineCapability({ ...validConfig(), output: 'string' as any })).toThrow(
      'output must be a Zod schema',
    );
  });

  it('throws if effects is missing', () => {
    expect(() => defineCapability({ ...validConfig(), effects: undefined as any })).toThrow(
      'effects declaration is required',
    );
  });

  it('throws if handler is not a function', () => {
    expect(() => defineCapability({ ...validConfig(), handler: 'nope' as any })).toThrow(
      'handler function is required',
    );
  });

  it('accepts exposeAs mcp with description', () => {
    const cap = defineCapability({
      ...validConfig(),
      description: 'Agent tool',
      exposeAs: ['mcp'],
      mcp: { dangerous: false, agentTags: ['users'] },
    });
    expect(cap.exposeAs).toEqual(['mcp']);
    expect(Object.isFrozen(cap.mcp)).toBe(true);
  });

  it('throws on invalid mcp shape', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        description: 'x',
        exposeAs: ['mcp'],
        mcp: { dangerous: 'yes' } as any,
      }),
    ).toThrow('invalid mcp config');
  });

  it('throws when eventHandler is exposed via MCP', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        kind: 'eventHandler',
        description: 'x',
        exposeAs: ['mcp'],
      }),
    ).toThrow('eventHandler cannot be exposed via MCP');
  });

  it('throws when MCP-exposed without agent-facing description', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        exposeAs: ['mcp'],
      }),
    ).toThrow('MCP-exposed capabilities require');
  });

  it('tag-only exposure does not register as MCP without exposeAs', () => {
    const cap = defineCapability({
      ...validConfig(),
      tags: ['mcp:expose'],
    });
    expect(cap.exposeAs).toBeUndefined();
  });

  const validApiBlock = () => ({
    operationId: 'getUser',
    method: 'GET' as const,
    path: '/users/{userId}',
  });

  it('accepts exposeAs api with valid api block', () => {
    const cap = defineCapability({
      ...validConfig(),
      exposeAs: ['api'],
      api: validApiBlock(),
    });
    expect(cap.exposeAs).toEqual(['api']);
    expect(cap.api?.operationId).toBe('getUser');
  });

  it('rejects api metadata without exposeAs api', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        api: validApiBlock(),
      }),
    ).toThrow("api metadata requires exposeAs: ['api']");
  });

  it('rejects eventHandler exposed via api', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        kind: 'eventHandler',
        exposeAs: ['api'],
        api: validApiBlock(),
      }),
    ).toThrow('eventHandler cannot be exposed via API');
  });

  it('rejects job exposed via api', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        kind: 'job',
        exposeAs: ['api'],
        api: validApiBlock(),
      }),
    ).toThrow('job cannot be exposed via API');
  });

  it('rejects api exposure missing api block', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        exposeAs: ['api'],
      }),
    ).toThrow('API-exposed capabilities require an api block');
  });

  it('rejects invalid api config (missing path)', () => {
    expect(() =>
      defineCapability({
        ...validConfig(),
        exposeAs: ['api'],
        api: {
          operationId: 'getUser',
          method: 'GET',
        } as any,
      }),
    ).toThrow('invalid api config');
  });

  it('freezes the api block', () => {
    const cap = defineCapability({
      ...validConfig(),
      exposeAs: ['api'],
      api: validApiBlock(),
    });
    expect(Object.isFrozen(cap.api)).toBe(true);
  });
});
