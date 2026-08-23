import { describe, expect, it } from 'vitest';
import { fillPromptTemplate } from '../fill-prompt-template.js';

describe('fillPromptTemplate', () => {
  it('replaces top-level {{key}} placeholders', () => {
    const { text, substitutedKeys } = fillPromptTemplate('Hello {{name}}', { name: 'Ada' });
    expect(text).toBe('Hello Ada');
    expect([...substitutedKeys]).toEqual(['name']);
  });

  it('leaves unknown placeholders unchanged', () => {
    const { text, substitutedKeys } = fillPromptTemplate('Keep {{missing}}', { name: 'Ada' });
    expect(text).toBe('Keep {{missing}}');
    expect(substitutedKeys.size).toBe(0);
  });

  it('inserts $ sequences as literal text, not replacement patterns', () => {
    const template = '## Head\n{{slot}}\n## Tail\n{{later}}';
    const cases: Array<{ value: string; expected: string }> = [
      { value: "Appendix $'", expected: "Appendix $'" },
      { value: 'Notes $` keep going', expected: 'Notes $` keep going' },
      { value: 'See $& here', expected: 'See $& here' },
      { value: 'Group $1', expected: 'Group $1' },
      { value: 'Dollar $$', expected: 'Dollar $$' },
    ];
    for (const { value, expected } of cases) {
      const { text } = fillPromptTemplate(template, { slot: value, later: 'ONCE' });
      expect(text).toBe(`## Head\n${expected}\n## Tail\nONCE`);
      expect(text.split('## Head').length - 1).toBe(1);
      expect(text.split('ONCE').length - 1).toBe(1);
    }
  });

  it('does not expand {{laterKey}} that appears inside an earlier value', () => {
    const { text } = fillPromptTemplate('Outline: {{outline}}\nBody: {{body}}', {
      outline: 'Verified {{body}}',
      body: 'BODY_ONCE',
    });
    expect(text).toBe('Outline: Verified {{body}}\nBody: BODY_ONCE');
    expect(text.split('BODY_ONCE').length - 1).toBe(1);
  });

  it('does not expand {{earlierKey}} that appears inside a later value', () => {
    const { text } = fillPromptTemplate('A: {{a}}\nB: {{b}}', {
      a: 'FIRST',
      b: 'see {{a}}',
    });
    expect(text).toBe('A: FIRST\nB: see {{a}}');
    expect(text.split('FIRST').length - 1).toBe(1);
  });

  it('stringifies non-string values the same way as String()', () => {
    const { text } = fillPromptTemplate('n={{n}} z={{z}}', { n: 0, z: null });
    expect(text).toBe('n=0 z=null');
  });
});
