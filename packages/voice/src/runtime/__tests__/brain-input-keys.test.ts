import { describe, expect, it } from 'vitest';
import { mergeRoomBrainInput } from '../worker.js';

describe('mergeRoomBrainInput', () => {
  it('uses sessionId not interviewSessionId', () => {
    const merged = mergeRoomBrainInput(undefined, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      language: 'he',
    });
    expect(merged).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      language: 'he',
    });
    expect(merged).not.toHaveProperty('interviewSessionId');
  });

  it('merges metadata over base brainInput without dropping extras', () => {
    const merged = mergeRoomBrainInput(
      { tone: 'warm' },
      {
        sessionId: 'sess-2',
        language: 'en',
      },
    );
    expect(merged).toEqual({
      tone: 'warm',
      sessionId: 'sess-2',
      language: 'en',
    });
  });
});
