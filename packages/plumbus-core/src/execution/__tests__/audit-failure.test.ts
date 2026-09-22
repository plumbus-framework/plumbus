import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../define/index.js';
import { createTestContext } from '../../testing/index.js';
import { executeCapability } from '../capability-executor.js';

it('does not report capability success when required audit persistence fails', async () => {
  const capability = defineCapability({
    name: 'audited',
    domain: 'test',
    kind: 'query',
    access: { public: true },
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  });
  const ctx = createTestContext();
  ctx.audit.record = vi.fn().mockRejectedValue(new Error('offline'));
  await expect(executeCapability(capability, ctx, {})).rejects.toThrow('Audit persistence failed');
});
