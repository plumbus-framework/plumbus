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

  it('requests spelling prompt for mixed-script proper names with low confidence', () => {
    const repair = assessHearingRepairNeeded({
      transcript: 'John דוד',
      confidence: 0.4,
      language: 'he',
      trigger: 'final',
    });
    expect(repair.needed).toBe(true);
    expect(repair.reason).toBe('uncertain_name');
    expect(repair.prompt).toContain('לאיית');
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
