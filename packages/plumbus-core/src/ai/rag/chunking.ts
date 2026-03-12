// ── Document Chunking ──
// Split documents into chunks for embedding and retrieval

export interface ChunkConfig {
  /** Maximum chunk size in characters (default: 1000) */
  maxChunkSize?: number;
  /** Overlap between chunks in characters (default: 200) */
  overlap?: number;
  /** Chunking strategy */
  strategy?: 'size' | 'paragraph';
}

export interface DocumentChunk {
  content: string;
  index: number;
  metadata?: Record<string, unknown>;
}

/**
 * Split text into overlapping chunks
 */
export function chunkDocument(text: string, config?: ChunkConfig): DocumentChunk[] {
  const strategy = config?.strategy ?? 'size';

  if (strategy === 'paragraph') {
    return chunkByParagraph(text, config);
  }
  return chunkBySize(text, config);
}

function chunkBySize(text: string, config?: ChunkConfig): DocumentChunk[] {
  const maxSize = config?.maxChunkSize ?? 1000;
  const overlap = config?.overlap ?? 200;
  const chunks: DocumentChunk[] = [];

  if (text.length <= maxSize) {
    return [{ content: text, index: 0 }];
  }

  let start = 0;
  let idx = 0;
  while (start < text.length) {
    const end = Math.min(start + maxSize, text.length);
    chunks.push({ content: text.slice(start, end), index: idx });
    idx++;
    if (end === text.length) break;
    start = end - overlap;
    // Avoid tiny trailing chunks
    if (text.length - start <= overlap) {
      chunks.push({ content: text.slice(start), index: idx });
      break;
    }
  }

  return chunks;
}

function chunkByParagraph(text: string, config?: ChunkConfig): DocumentChunk[] {
  const maxSize = config?.maxChunkSize ?? 1000;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: DocumentChunk[] = [];

  let current = '';
  let idx = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 1 > maxSize && current.length > 0) {
      chunks.push({ content: current.trim(), index: idx });
      idx++;
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({ content: current.trim(), index: idx });
  }

  return chunks;
}
