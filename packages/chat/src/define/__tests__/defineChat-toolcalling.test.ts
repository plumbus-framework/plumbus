import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import { defineChat } from '../defineChat.js';

describe('defineChat — tool calling policy', () => {
  it('accepts policy.toolCalling.enabled with capabilities', () => {
    const def = defineChat({
      name: 'tc',
      access: {},
      policy: {
        toolCalling: {
          enabled: true,
          capabilities: ['readThing'],
        },
      },
    });
    expect(def.policy?.toolCalling?.enabled).toBe(true);
  });

  it('rejects toolCalling combined with a legacy action allowlist', () => {
    expect(() =>
      defineChat({
        name: 'tc',
        access: {},
        actions: ['writeThing'],
        policy: {
          toolCalling: { enabled: true, capabilities: ['readThing'] },
        },
      }),
    ).toThrow(/choose one action path/);
  });

  it('rejects toolCalling with saveToDb:false', () => {
    expect(() =>
      defineChat({
        name: 'tc',
        access: {},
        persistence: { messageContent: 'client', saveToDb: false },
        policy: {
          toolCalling: { enabled: true, capabilities: ['readThing'] },
        },
      }),
    ).toThrow(/tool execution records require chat_turn rows/);
  });

  it('accepts agent orchestration with a custom prompt', () => {
    const prompt = {
      name: 'interview.agent',
      input: z.object({}),
      output: z.object({ content: z.string() }),
    } as never;
    const def = defineChat({
      name: 'interview',
      access: {},
      prompt,
      policy: {
        toolCalling: {
          enabled: true,
          capabilities: ['explainProcess'],
          orchestration: 'agent',
          scopePreflight: false,
          ai: {
            provider: 'anthropic',
            model: 'tool-model',
            reasoning: { mode: 'effort', effort: 'medium' },
          },
        },
      },
    });

    expect(def.policy?.toolCalling?.orchestration).toBe('agent');
    expect(def.policy?.toolCalling?.scopePreflight).toBe(false);
    expect(def.policy?.toolCalling?.ai).toEqual({
      provider: 'anthropic',
      model: 'tool-model',
      reasoning: { mode: 'effort', effort: 'medium' },
    });
  });

  it('rejects ambiguous new and legacy reasoning configuration', () => {
    expect(() =>
      defineChat({
        name: 'ambiguous',
        access: {},
        policy: {
          toolCalling: {
            enabled: true,
            ai: {
              reasoning: { mode: 'disabled' },
              reasoningEffort: 'low',
            },
          },
        },
      }),
    ).toThrow(/cannot set both reasoning and deprecated reasoningEffort/);
  });

  it('rejects agent orchestration without a custom prompt', () => {
    expect(() =>
      defineChat({
        name: 'interview',
        access: {},
        policy: { toolCalling: { enabled: true, orchestration: 'agent' } },
      }),
    ).toThrow("orchestration='agent' requires a custom plain-text prompt");
  });

  it('rejects out-of-range maxToolRounds', () => {
    expect(() =>
      defineChat({
        name: 'tc',
        access: {},
        policy: {
          toolCalling: { enabled: true, maxToolRounds: 21 },
        },
      }),
    ).toThrow();
  });

  it('folds top-level actions into policy.action.allowedCapabilities', () => {
    const def = defineChat({
      name: 'tc',
      access: {},
      actions: ['a'],
    });
    expect(def.policy?.action?.allowedCapabilities).toEqual(['a']);
  });
});
