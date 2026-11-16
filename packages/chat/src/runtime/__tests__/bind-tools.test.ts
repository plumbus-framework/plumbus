import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import type { CapabilityContract, ExecutionContext } from '@plumbus/core';
import { zodToProviderJsonSchema } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { capabilityInputSchemaHashV2 } from '../../policy/action-schema-hash.js';
import { bindChatCapabilityTools, ChatToolBindError, resolveToolBinding } from '../bind-tools.js';

function makeCap(name: string, overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain: 'test',
    description: 'Read something',
    input: z.object({ q: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: true },
    access: { roles: ['user'] },
    handler: async () => ({ ok: true }),
    ...overrides,
  } as CapabilityContract;
}

/** Tool names are portable (no dots); resolve by short capability.name. */
function ctxWithCaps(caps: CapabilityContract[]): ExecutionContext {
  const byName = new Map(caps.map((c) => [c.name, c]));
  const ctx = createTestContext({ capabilities: caps });
  return {
    ...ctx,
    __runtime: {
      ...ctx.__runtime,
      resolveCapability: (name: string) =>
        byName.get(name) ?? ctx.__runtime?.resolveCapability?.(name),
    },
  };
}

describe('bindChatCapabilityTools', () => {
  it('binds a read capability with mode auto and provider schema', () => {
    const cap = makeCap('readThing');
    const ctx = ctxWithCaps([cap]);
    const bound = bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    expect(bound).toHaveLength(1);
    expect(bound[0]?.mode).toBe('auto');
    const { schema } = zodToProviderJsonSchema(cap.input, { promptName: 'readThing' });
    expect(bound[0]?.tool.parameters).toEqual(schema);
  });

  it('sets targetVersion from cap.version when present, else schema-hash fallback', () => {
    const capNoVersion = makeCap('readA');
    const ctxA = ctxWithCaps([capNoVersion]);
    const boundA = bindChatCapabilityTools(ctxA, ['readA'], { maxTools: 32 });
    const { schema } = zodToProviderJsonSchema(capNoVersion.input, {
      promptName: 'readA',
    });
    const inputSchemaHash = capabilityInputSchemaHashV2(schema);
    expect(boundA[0]?.targetVersion).toBe(inputSchemaHash);

    const capVersioned = makeCap('readB', { version: '2.0.0' });
    const ctxB = ctxWithCaps([capVersioned]);
    const boundB = bindChatCapabilityTools(ctxB, ['readB'], { maxTools: 32 });
    expect(boundB[0]?.targetVersion).toBe('2.0.0');
  });

  it('throws chat.tool_name_invalid for the reserved flow__ prefix', () => {
    const cap = makeCap('flow__bad');
    const ctx = ctxWithCaps([cap]);
    expect(() => bindChatCapabilityTools(ctx, ['flow__bad'], { maxTools: 32 })).toThrow(
      ChatToolBindError,
    );
    try {
      bindChatCapabilityTools(ctx, ['flow__bad'], { maxTools: 32 });
    } catch (err) {
      expect(err).toBeInstanceOf(ChatToolBindError);
      expect((err as ChatToolBindError).code).toBe('chat.tool_name_invalid');
    }
  });

  it('throws chat.tool_unknown_capability when resolve returns undefined', () => {
    const base = createTestContext();
    const ctx: ExecutionContext = {
      ...base,
      __runtime: {
        ...base.__runtime,
        resolveCapability: () => undefined,
      },
    };
    expect(() => bindChatCapabilityTools(ctx, ['missing'], { maxTools: 32 })).toThrow(
      ChatToolBindError,
    );
    try {
      bindChatCapabilityTools(ctx, ['missing'], { maxTools: 32 });
    } catch (err) {
      expect((err as ChatToolBindError).code).toBe('chat.tool_unknown_capability');
    }
  });

  it('throws chat.tools_runtime_unavailable without resolveCapability', () => {
    const ctx = createTestContext();
    expect(() => bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 })).toThrow(
      ChatToolBindError,
    );
    try {
      bindChatCapabilityTools(ctx, ['readThing'], { maxTools: 32 });
    } catch (err) {
      expect((err as ChatToolBindError).code).toBe('chat.tools_runtime_unavailable');
    }
  });

  describe('with the runtime resolver (canonical names only, as over HTTP)', () => {
    it('binds a canonical name and gives the provider the capability name', () => {
      const cap = makeCap('readHelpPage', { domain: 'support' });
      const ctx = createTestContext({ capabilities: [cap] });
      const bound = bindChatCapabilityTools(ctx, ['support.readHelpPage'], { maxTools: 32 });
      expect(bound).toHaveLength(1);
      expect(bound[0]?.tool.name).toBe('readHelpPage');
      expect(bound[0]?.targetName).toBe('support.readHelpPage');
      expect(bound[0]?.capability).toBe(cap);
    });

    it('keeps the binding hash in step with resolveToolBinding for the canonical target', async () => {
      const cap = makeCap('openTicket', {
        domain: 'support',
        effects: { data: ['Ticket'], events: [], external: [], ai: false },
      });
      const ctx = createTestContext({ capabilities: [cap] });
      const [bound] = bindChatCapabilityTools(ctx, ['support.openTicket'], { maxTools: 32 });
      const recomputed = await resolveToolBinding(ctx, 'capability', 'support.openTicket');
      expect(recomputed).toEqual({
        ok: true,
        inputSchemaHash: bound?.inputSchemaHash,
        toolBindingHash: bound?.toolBindingHash,
      });
    });

    it('explains the canonical form when a bare name cannot be resolved', () => {
      const cap = makeCap('readHelpPage', { domain: 'support' });
      const ctx = createTestContext({ capabilities: [cap] });
      try {
        bindChatCapabilityTools(ctx, ['readHelpPage'], { maxTools: 32 });
        expect.unreachable('expected a bind error');
      } catch (err) {
        expect((err as ChatToolBindError).code).toBe('chat.tool_unknown_capability');
        expect((err as Error).message).toContain('<domain>.<name>');
      }
    });

    it('rejects two canonical names that bind to the same tool name', () => {
      const a = makeCap('lookup', { domain: 'orders' });
      const b = makeCap('lookup', { domain: 'billing' });
      const ctx = createTestContext({ capabilities: [a, b] });
      try {
        bindChatCapabilityTools(ctx, ['orders.lookup', 'billing.lookup'], { maxTools: 32 });
        expect.unreachable('expected a bind error');
      } catch (err) {
        expect((err as ChatToolBindError).code).toBe('chat.tool_name_invalid');
      }
    });

    it('still rejects a canonical entry whose capability name is not portable', () => {
      const cap = makeCap('flow__sneaky', { domain: 'support' });
      const ctx = createTestContext({ capabilities: [cap] });
      try {
        bindChatCapabilityTools(ctx, ['support.flow__sneaky'], { maxTools: 32 });
        expect.unreachable('expected a bind error');
      } catch (err) {
        expect((err as ChatToolBindError).code).toBe('chat.tool_name_invalid');
      }
    });
  });

  it('caps to maxTools', () => {
    const caps = [makeCap('capA'), makeCap('capB'), makeCap('capC')];
    const ctx = ctxWithCaps(caps);
    const bound = bindChatCapabilityTools(ctx, ['capA', 'capB', 'capC'], { maxTools: 2 });
    expect(bound).toHaveLength(2);
    expect(bound.map((b) => b.tool.name)).toEqual(['capA', 'capB']);
  });
});
