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
});
