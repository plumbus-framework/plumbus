import { describe, expect, it, vi } from 'vitest';
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { defineChat } from '../defineChat.js';

describe('defineChat', () => {
  it('accepts valid minimal config', () => {
    const chat = defineChat({
      name: 'test',
      access: {},
    });
    expect(chat.name).toBe('test');
    expect(chat.kind).toBe('chat');
  });

  it('rejects when name missing', () => {
    expect(() =>
      defineChat({
        name: '',
        access: {},
      }),
    ).toThrow();
  });

  it('warns but accepts empty context', () => {
    const chat = defineChat({
      name: 'bare',
      access: {},
      context: [],
    });
    expect(chat.context).toEqual([]);
  });

  it('rejects empty audience roles in strict mode', () => {
    expect(() =>
      defineChat({
        name: 'x',
        access: {},
        policy: { audience: { roles: [], mode: 'strict' } },
      }),
    ).toThrow();
  });

  it('defaults streaming to true', () => {
    const def = defineChat({ name: 'x', access: {} });
    expect(def.streaming).toBe(true);
  });

  it('respects streaming: false', () => {
    const def = defineChat({ name: 'x', access: {}, streaming: false });
    expect(def.streaming).toBe(false);
  });

  it('accepts persistence client', () => {
    const chat = defineChat({
      name: 'c',
      access: {},
      persistence: { messageContent: 'client' },
    });
    expect(chat.persistence?.messageContent).toBe('client');
  });

  it('defaults persistence.saveToDb to true', () => {
    const chat = defineChat({ name: 'd', access: {} });
    expect(chat.persistence?.saveToDb).toBe(true);
  });

  it('respects persistence.saveToDb: false when paired with messageContent: "client"', () => {
    const chat = defineChat({
      name: 'ephem',
      access: {},
      persistence: { messageContent: 'client', saveToDb: false },
    });
    expect(chat.persistence?.saveToDb).toBe(false);
    expect(chat.persistence?.messageContent).toBe('client');
  });

  it('rejects saveToDb: false with messageContent: "server"', () => {
    expect(() =>
      defineChat({
        name: 'bad',
        access: {},
        persistence: { messageContent: 'server', saveToDb: false },
      }),
    ).toThrow(/saveToDb=false/);
  });

  it('rejects saveToDb: false with policy.action.allowedCapabilities', () => {
    expect(() =>
      defineChat({
        name: 'bad-action',
        access: {},
        persistence: { messageContent: 'client', saveToDb: false },
        policy: { action: { allowedCapabilities: ['doThing'] } },
      }),
    ).toThrow(/saveToDb=false.*action/);
  });

  it('accepts a per-chat prompt override (Decision 0008)', () => {
    const helpPrompt = definePrompt({
      name: 'custom.help.prompt',
      domain: 'support',
      description: 'A custom help prompt with a richer system body.',
      input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
      output: z.object({
        inScope: z.boolean(),
        answer: z.string(),
        refusalReason: z
          .enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request'])
          .nullable(),
        citedSources: z.array(z.string()),
        requestedAction: z.unknown().nullable(),
      }),
    });

    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['You are the help bot'],
      prompt: helpPrompt,
    });

    expect(chat.prompt).toBeDefined();
    expect(chat.prompt?.name).toBe('custom.help.prompt');
  });

  it('accepts perTurn token and cost limits without define-time warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defineChat({
      name: 'budgetChat',
      access: {},
      budget: { perTurn: { tokens: 6000, costUsd: 0.5 } },
    });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('budget.perTurn.tokens'));
    warn.mockRestore();
  });
});
