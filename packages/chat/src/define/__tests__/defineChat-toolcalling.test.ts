import { describe, expect, it } from 'vitest';
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
