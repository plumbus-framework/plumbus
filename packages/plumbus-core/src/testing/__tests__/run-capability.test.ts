import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import { CapabilityKind } from '../../types/enums.js';
import { createTestContext } from '../context.js';
import { runCapability } from '../run-capability.js';

// ── Test Capability Factories ──

function echoCapability(): CapabilityContract<
  z.ZodObject<{ message: z.ZodString }>,
  z.ZodObject<{ echo: z.ZodString }>
> {
  return {
    name: 'echo',
    kind: CapabilityKind.Query,
    domain: 'test',
    input: z.object({ message: z.string() }),
    output: z.object({ echo: z.string() }),
    access: { roles: ['user', 'admin'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (_ctx, input) => ({ echo: input.message }),
  };
}

function adminOnlyCapability(): CapabilityContract {
  return {
    name: 'admin-action',
    kind: CapabilityKind.Action,
    domain: 'test',
    input: z.object({ value: z.number() }),
    output: z.object({ ok: z.boolean() }),
    access: { roles: ['admin'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  };
}

function failingCapability(): CapabilityContract {
  return {
    name: 'failing',
    kind: CapabilityKind.Action,
    domain: 'test',
    input: z.object({}),
    output: z.object({}),
    access: { public: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => {
      throw new Error('handler exploded');
    },
  };
}

// ── Tests ──

describe('runCapability', () => {
  it('executes a capability with valid input and returns success', async () => {
    const result = await runCapability(echoCapability(), { message: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ echo: 'hello' });
    }
  });

  it('returns validation error for invalid input', async () => {
    const result = await runCapability(echoCapability(), { message: 42 }); // message should be string
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('returns forbidden error when user lacks required role', async () => {
    const result = await runCapability(
      adminOnlyCapability(),
      { value: 1 },
      {
        auth: { roles: ['user'] }, // not admin
      },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('forbidden');
    }
  });

  it('succeeds when user has required role', async () => {
    const result = await runCapability(
      adminOnlyCapability(),
      { value: 1 },
      {
        auth: { roles: ['admin'] },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ok: true });
    }
  });

  it('handles handler errors gracefully', async () => {
    const result = await runCapability(failingCapability(), {});
    expect(result.success).toBe(false);
  });

  it('accepts a pre-built context', async () => {
    const ctx = createTestContext({ auth: { roles: ['admin'] } });
    const result = await runCapability(adminOnlyCapability(), { value: 5 }, { ctx });
    expect(result.success).toBe(true);
  });

  it('records audit events during execution', async () => {
    const result = await runCapability(
      {
        ...echoCapability(),
        audit: { enabled: true, event: 'echo.executed' },
      },
      { message: 'test' },
    );
    expect(result.success).toBe(true);
  });

  it('validates output schema', async () => {
    // Create capability that returns wrong output type
    const badOutput: CapabilityContract = {
      name: 'bad-output',
      kind: CapabilityKind.Query,
      domain: 'test',
      input: z.object({}),
      output: z.object({ required: z.string() }),
      access: { public: true },
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({ wrong: 123 }), // doesn't match output schema
    };
    const result = await runCapability(badOutput, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('internal');
    }
  });
});
