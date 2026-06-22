import { describe, expect, it } from 'vitest';
import { createSentenceChunker, splitSentenceChunks } from '../sentence-chunker.js';

describe('sentence chunker smoke', () => {
  it('splits English sentences at punctuation boundaries', () => {
    expect(splitSentenceChunks('Hello world. More help is coming!')).toEqual([
      'Hello world.',
      'More help is coming!',
    ]);
  });

  it('flushes Hebrew + mixed text without dropping the tail chunk', () => {
    const chunker = createSentenceChunker();

    expect(chunker.push('שלום עולם. More')).toEqual(['שלום עולם.']);
    expect(chunker.flush()).toEqual(['More']);
  });
});
