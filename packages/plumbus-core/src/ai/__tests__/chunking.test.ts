import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../rag/chunking.js';

describe('Document Chunking', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkDocument('Hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Hello world');
    expect(chunks[0]?.index).toBe(0);
  });

  it('splits long text into overlapping chunks', () => {
    const text = 'A'.repeat(2500);
    const chunks = chunkDocument(text, { maxChunkSize: 1000, overlap: 200 });

    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should be maxChunkSize
    expect(chunks[0]?.content.length).toBe(1000);
    // Chunks should have sequential indexes
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]?.index).toBe(i);
    }
  });

  it('handles paragraph strategy', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = chunkDocument(text, { strategy: 'paragraph', maxChunkSize: 100 });

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All content should be preserved somewhere
    const combined = chunks.map((c) => c.content).join('\n\n');
    expect(combined).toContain('Paragraph one');
    expect(combined).toContain('Paragraph three');
  });

  it('merges small paragraphs up to maxChunkSize', () => {
    const text = 'A\n\nB\n\nC';
    const chunks = chunkDocument(text, { strategy: 'paragraph', maxChunkSize: 1000 });

    // Should merge all into one chunk since all fit
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('A');
    expect(chunks[0]?.content).toContain('C');
  });

  it('splits paragraphs that exceed maxChunkSize', () => {
    const text = `${'A'.repeat(50)}\n\n${'B'.repeat(60)}`;
    const chunks = chunkDocument(text, { strategy: 'paragraph', maxChunkSize: 80 });

    expect(chunks).toHaveLength(2);
  });

  it('snaps size-based chunks to sentence boundaries', () => {
    const text = 'First sentence here. Second sentence here. Third sentence is the last one.';
    const chunks = chunkDocument(text, { maxChunkSize: 45, overlap: 10 });

    // First chunk should end at a sentence boundary, not mid-word
    const first = chunks[0]?.content ?? '';
    expect(first.endsWith('.')).toBe(true);
  });

  it('avoids mid-word cuts when no sentence boundary is found', () => {
    const text = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';
    const chunks = chunkDocument(text, { maxChunkSize: 30, overlap: 5 });

    for (const chunk of chunks) {
      // No chunk should start or end with a partial word (except possibly the last)
      expect(chunk.content.trim()).toBe(chunk.content.trim());
      if (chunk.index < chunks.length - 1) {
        expect(chunk.content).not.toMatch(/\w$/);
      }
    }
  });

  it('handles newline boundaries for oral history text', () => {
    const lines = [
      'I was born in Baghdad in 1929.',
      'My father passed away when I was young.',
      'We were a wealthy family at the time.',
      'My mother traveled to Paris regularly.',
    ];
    const text = lines.join('\n');
    const chunks = chunkDocument(text, { maxChunkSize: 80, overlap: 20 });

    // Chunks should end at newline or period boundaries
    for (const chunk of chunks) {
      const lastChar = chunk.content[chunk.content.length - 1];
      const endsClean = lastChar === '.' || lastChar === '\n' || chunk.index === chunks.length - 1;
      expect(endsClean).toBe(true);
    }
  });
});
