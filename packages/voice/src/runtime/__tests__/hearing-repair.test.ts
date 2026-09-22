import { describe, expect, it } from 'vitest';
import { assessHearingRepairNeeded } from '../hearing-repair.js';

describe('assessHearingRepairNeeded', () => {
  it('requests repeat prompt for empty endpoint only after speech energy', () => {
    const withoutEnergy = assessHearingRepairNeeded({
      transcript: '',
      language: 'he',
      trigger: 'endpoint',
      hadSpeechEnergy: false,
    });
    expect(withoutEnergy.needed).toBe(false);

    const withEnergy = assessHearingRepairNeeded({
      transcript: '',
      language: 'he',
      trigger: 'endpoint',
      hadSpeechEnergy: true,
    });
    expect(withEnergy.needed).toBe(true);
    expect(withEnergy.reason).toBe('empty');
    expect(withEnergy.prompt).toContain('לא הצלחתי');
  });

  it('flags low-confidence transcripts as low_confidence signals without judging content', () => {
    const repair = assessHearingRepairNeeded({
      transcript: 'John דוד',
      confidence: 0.4,
      language: 'he',
      trigger: 'final',
    });
    expect(repair.needed).toBe(true);
    expect(repair.reason).toBe('low_confidence');
    // The framework ships no prompt for content-level repairs — the app hook
    // decides whether this transcript is a name, a mumble, or nothing at all.
    expect(repair.prompt).toBeUndefined();
  });

  it('flags any low-confidence transcript, name-shaped or not', () => {
    const repair = assessHearingRepairNeeded({
      transcript: 'גדלתי בעיר קטנה',
      confidence: 0.3,
      language: 'he',
      trigger: 'final',
    });
    expect(repair.needed).toBe(true);
    expect(repair.reason).toBe('low_confidence');
  });

  it('does not repair short transcripts without explicit low confidence', () => {
    const repair = assessHearingRepairNeeded({
      transcript: 'כן',
      language: 'he',
      trigger: 'final',
    });
    expect(repair.needed).toBe(false);
  });

  it('accepts confident normal transcripts', () => {
    const repair = assessHearingRepairNeeded({
      transcript: 'גדלתי בעיר קטנה ליד הים',
      confidence: 0.92,
      language: 'he',
      trigger: 'final',
    });
    expect(repair.needed).toBe(false);
  });
});
