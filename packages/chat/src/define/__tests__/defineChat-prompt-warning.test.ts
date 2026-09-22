import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { describe, expect, it, vi } from 'vitest';
import { defineChat } from '../defineChat.js';

describe('defineChat custom prompt base-field warning (C11)', () => {
  it('warns when custom prompt output omits base fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const narrowPrompt = definePrompt({
      name: 'chat.narrow',
      domain: 'chat',
      description: 'narrow',
      input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
      output: z.object({
        inScope: z.boolean(),
        answer: z.string(),
      }),
      model: { temperature: 0.2 },
    });

    defineChat({
      name: 'help',
      access: {},
      context: [{ id: 'c1', tier: 1, resolve: async () => ({ blocks: [] }) }],
      prompt: narrowPrompt,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing base fields'));
    warn.mockRestore();
  });
});
