import { describe, expect, it } from 'vitest';
import { provenanceGuard } from '../provenance-guard.js';
import type { GuardState } from '../../types/policy.js';

function guardState(overrides: Partial<GuardState> = {}): GuardState {
  return {
    ctx: {} as GuardState['ctx'],
    chatName: 'help',
    policy: {},
    resolvedSources: new Set(['src_a']),
    saveToDb: true,
    ...overrides,
  };
}

describe('C7/C10 enforcement matrix (unit)', () => {
  it('C7: blocks when cited sources are below minSources', async () => {
    const verdict = await provenanceGuard(
      { sessionId: 's1', ordinal: 0, userId: 'u1', audience: 'user', locale: 'en' },
      guardState({
        policy: { provenance: { minSources: 2 } },
        modelOutput: { citedSources: ['src_a'], answer: 'text' },
      }),
    );
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('provenance_insufficient');
  });

  it('C7: allows when minSources is satisfied', async () => {
    const verdict = await provenanceGuard(
      { sessionId: 's1', ordinal: 0, userId: 'u1', audience: 'user', locale: 'en' },
      guardState({
        policy: { provenance: { minSources: 1 } },
        modelOutput: { citedSources: ['src_a'], answer: 'text' },
      }),
    );
    expect(verdict.decision).toBe('allow');
  });
});
