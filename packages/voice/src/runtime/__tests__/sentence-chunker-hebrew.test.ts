import { describe, expect, it } from 'vitest';
import { createSentenceChunker, splitSentenceChunks } from '../sentence-chunker.js';

describe('sentence chunker Hebrew boundaries', () => {
  it('splits on Hebrew sof pasuq and paragraph breaks', () => {
    expect(splitSentenceChunks('שלום עולם׃ More text')).toEqual(['שלום עולם׃', 'More text']);
    expect(splitSentenceChunks('First block\n\nSecond block')).toEqual([
      'First block',
      'Second block',
    ]);
  });

  it('keeps an oversized unbroken word intact instead of synthesizing fragments', () => {
    const long = 'a'.repeat(250);
    const chunks = splitSentenceChunks(long);
    expect(chunks).toEqual([long]);
  });

  it('preserves Hebrew words and niqqud across the 200-character size fallback', () => {
    const words = Array.from({ length: 60 }, (_, i) => `זִכָּרוֹן${i}`);
    const chunks = splitSentenceChunks(words.join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((chunk) => chunk.split(' '))).toEqual(words);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
  });

  it('does not slice a streamed word or emoji at the size threshold', () => {
    const text = `${'מילה '.repeat(38)}משפחתיות👨‍👩‍👧‍👦 והמשך הסיפור.`;
    for (const deltaSize of [1, 7, 199, 200, 201, text.length]) {
      const chunker = createSentenceChunker();
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += deltaSize)
        chunks.push(...chunker.push(text.slice(i, i + deltaSize)));
      chunks.push(...chunker.flush());
      expect(chunks.flatMap((chunk) => chunk.split(/\s+/u))).toEqual(text.split(/\s+/u));
    }
  });

  it('waits for a long word to finish across streaming deltas', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('א'.repeat(210))).toEqual([]);
    expect(chunker.push('ב'.repeat(20))).toEqual([]);
    expect(chunker.push(' הסוף')).toEqual(['א'.repeat(210) + 'ב'.repeat(20)]);
    expect(chunker.flush()).toEqual(['הסוף']);
  });
});

describe('sentence chunker micro-fragment merging', () => {
  it('never emits a leading hesitation as its own synthesis call', () => {
    // Synthesized alone, "המממ..." is read as disconnected syllables
    // ("HAMAMAMA"); merged into its sentence it reads naturally.
    expect(splitSentenceChunks('המממ... איזה סיפור מרגש. ספרי לי עוד על זה.')).toEqual([
      'המממ... איזה סיפור מרגש.',
      'ספרי לי עוד על זה.',
    ]);
  });

  it('holds a small fragment across streaming deltas until its sentence arrives', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('המממ... ')).toEqual([]);
    expect(chunker.push('איזה יופי של זיכרון. ומה היה אחר כך?')).toEqual([
      'המממ... איזה יופי של זיכרון.',
      'ומה היה אחר כך?',
    ]);
    expect(chunker.flush()).toEqual([]);
  });

  it('flushes a trailing small fragment on its own when nothing follows', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('המממ...')).toEqual([]);
    expect(chunker.flush()).toEqual(['המממ...']);
  });

  it('minChunkChars: 0 restores per-sentence emission', () => {
    expect(splitSentenceChunks('המממ... איזה סיפור מרגש.', { minChunkChars: 0 })).toEqual([
      'המממ...',
      'איזה סיפור מרגש.',
    ]);
  });
});
