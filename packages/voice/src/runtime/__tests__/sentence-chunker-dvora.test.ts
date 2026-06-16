import { describe, expect, it } from 'vitest';
import { splitSentenceChunks } from '../sentence-chunker.js';

describe('sentence chunker dvora boundaries', () => {
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
