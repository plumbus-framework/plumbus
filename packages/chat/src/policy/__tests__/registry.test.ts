import { describe, expect, it } from 'vitest';
import type { Guard } from '../../types/policy.js';
import { compilePolicy } from '../registry.js';

const noop: Guard = async () => ({ decision: 'allow' });

describe('compilePolicy — custom guard staging', () => {
  it('places policy.custom at the end of preTurnGuards (pre-turn)', () => {
    const g1: Guard = async () => ({ decision: 'allow' });
    const { preTurnGuards, postTurnGuards } = compilePolicy({ custom: [g1] });
    expect(preTurnGuards[preTurnGuards.length - 1]).toBe(g1);
    expect(postTurnGuards).not.toContain(g1);
  });

  it('places policy.customPostTurn at the end of postTurnGuards (post-turn)', () => {
    const g2: Guard = async () => ({ decision: 'allow' });
    const { preTurnGuards, postTurnGuards } = compilePolicy({ customPostTurn: [g2] });
    expect(postTurnGuards[postTurnGuards.length - 1]).toBe(g2);
    expect(preTurnGuards).not.toContain(g2);
  });

  it('supports both pre- and post-turn custom guards simultaneously', () => {
    const pre: Guard = async () => ({ decision: 'allow' });
    const post: Guard = async () => ({ decision: 'allow' });
    const { preTurnGuards, postTurnGuards } = compilePolicy({
      custom: [pre],
      customPostTurn: [post],
    });
    expect(preTurnGuards).toContain(pre);
    expect(preTurnGuards).not.toContain(post);
    expect(postTurnGuards).toContain(post);
    expect(postTurnGuards).not.toContain(pre);
  });

  it('adds no custom guards when neither field is set', () => {
    const base = compilePolicy({});
    const withPre = compilePolicy({ custom: [noop] });
    expect(withPre.preTurnGuards.length).toBe(base.preTurnGuards.length + 1);
    expect(base.preTurnGuards.length).toBeGreaterThan(0);
  });
});
