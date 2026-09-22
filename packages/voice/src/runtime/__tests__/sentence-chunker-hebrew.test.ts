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

  it('forces chunks longer than 200 characters', () => {
    const long = 'a'.repeat(250);
    const chunks = splitSentenceChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
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
