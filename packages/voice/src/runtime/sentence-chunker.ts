export interface SentenceChunker {
  push(text: string): string[];
  flush(): string[];
}

export interface SentenceChunkerOptions {
  /**
   * Chunks shorter than this many characters are merged into the following
   * sentence instead of being emitted as their own synthesis call. An isolated
   * micro-fragment (a hesitation like "המממ...", a bare "כן.") synthesized
   * without sentence context is read as disconnected syllables by TTS engines;
   * merged into its sentence it reads naturally. Set 0 to disable.
   */
  minChunkChars?: number;
}

const MAX_CHUNK_CHARS = 200;
const DEFAULT_MIN_CHUNK_CHARS = 8;
const SENTENCE_BOUNDARY = /([.!?׃]|[。！？]+)(?=(?:\s|$))/u;
const PARAGRAPH_BOUNDARY = /\n\n+/;

export function createSentenceChunker(options: SentenceChunkerOptions = {}): SentenceChunker {
  const minChunkChars = options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  let buffer = '';
  let pendingSmall = '';

  const emit = (chunks: string[], piece: string): void => {
    for (const part of splitOversized(piece)) {
      const candidate = pendingSmall ? `${pendingSmall} ${part}` : part;
      if (candidate.length < minChunkChars) {
        pendingSmall = candidate;
        continue;
      }
      pendingSmall = '';
      chunks.push(candidate);
    }
  };

  const drainChunks = (): string[] => {
    const chunks: string[] = [];

    while (buffer.length > 0) {
      const paragraphSplit = splitAtParagraph(buffer);
      if (paragraphSplit) {
        const { chunk, rest } = paragraphSplit;
        if (chunk) emit(chunks, chunk);
        buffer = rest;
        continue;
      }

      const sentenceSplit = splitAtSentence(buffer);
      if (sentenceSplit) {
        const { chunk, rest } = sentenceSplit;
        if (chunk) emit(chunks, chunk);
        buffer = rest;
        continue;
      }

      if (buffer.length >= MAX_CHUNK_CHARS) {
        const forced = buffer.slice(0, MAX_CHUNK_CHARS).trim();
        if (forced) emit(chunks, forced);
        buffer = buffer.slice(MAX_CHUNK_CHARS).trimStart();
        continue;
      }

      break;
    }

    return chunks;
  };

  return {
    push(text: string): string[] {
      if (!text) return [];
      buffer += text;
      return drainChunks();
    },
    flush(): string[] {
      const tail = buffer.trim();
      buffer = '';
      const combined = pendingSmall ? (tail ? `${pendingSmall} ${tail}` : pendingSmall) : tail;
      pendingSmall = '';
      return combined ? splitOversized(combined) : [];
    },
  };
}

export function splitSentenceChunks(text: string, options?: SentenceChunkerOptions): string[] {
  const chunker = createSentenceChunker(options);
  const chunks = chunker.push(text);
  return [...chunks, ...chunker.flush()];
}

export function flushSentenceChunks(text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

function splitAtParagraph(text: string): { chunk: string; rest: string } | undefined {
  const match = PARAGRAPH_BOUNDARY.exec(text);
  if (!match || match.index < 0) return undefined;
  const endIndex = match.index + match[0].length;
  return {
    chunk: text.slice(0, match.index).trim(),
    rest: text.slice(endIndex).trimStart(),
  };
}

function splitAtSentence(text: string): { chunk: string; rest: string } | undefined {
  const match = SENTENCE_BOUNDARY.exec(text);
  if (!match || match.index < 0) return undefined;
  const endIndex = match.index + match[0].length;
  return {
    chunk: text.slice(0, endIndex).trim(),
    rest: text.slice(endIndex).trimStart(),
  };
}

function splitOversized(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > MAX_CHUNK_CHARS) {
    chunks.push(remaining.slice(0, MAX_CHUNK_CHARS));
    remaining = remaining.slice(MAX_CHUNK_CHARS).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
