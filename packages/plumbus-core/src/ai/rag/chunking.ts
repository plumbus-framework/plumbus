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

/**
 * Find the best sentence-boundary cut point by scanning backwards from `pos`.
 * Looks for `.` / `?` / `!` followed by whitespace, or `\n`.
 * Returns the index *after* the boundary char (i.e. the start of the next sentence).
 * Falls back to the nearest whitespace, then to `pos` itself if nothing found.
 */
function snapToSentenceBoundary(text: string, pos: number, minPos: number): number {
  // Scan backwards up to 20% of the distance from minPos
  const lookback = Math.floor((pos - minPos) * 0.2);
  const limit = Math.max(minPos, pos - lookback);

  for (let i = pos - 1; i >= limit; i--) {
    const ch = text[i];
    if (ch === '\n') return i + 1;
    if ((ch === '.' || ch === '?' || ch === '!') && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === ' ' || next === '\n' || next === '\r' || next === '\t') {
        return i + 1;
      }
    }
  }

  // Fallback: nearest whitespace boundary (avoid mid-word cuts)
  for (let i = pos - 1; i >= limit; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') return i + 1;
  }

  return pos;
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
    let end = Math.min(start + maxSize, text.length);

    if (end < text.length) {
      end = snapToSentenceBoundary(text, end, start);
    }

    chunks.push({ content: text.slice(start, end), index: idx });
    idx++;
    if (end >= text.length) break;

    // Overlap: step back, then snap forward to nearest sentence start
    let nextStart = end - overlap;
    if (nextStart <= start) {
      nextStart = end;
    } else {
      // Snap forward to the start of a sentence for clean overlap
      for (let i = nextStart; i < end; i++) {
        const ch = text[i];
        if (ch === '\n' || ch === '.' || ch === '?' || ch === '!') {
          const boundary = ch === '\n' ? i + 1 : i + 2;
          if (boundary <= end) {
            nextStart = boundary;
            break;
          }
        }
      }
    }
    start = nextStart;

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
