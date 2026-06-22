export interface SentenceChunker {
  push(text: string): string[];
  flush(): string[];
}

const MAX_CHUNK_CHARS = 200;
const SENTENCE_BOUNDARY = /([.!?׃]|[。！？]+)(?=(?:\s|$))/u;
const PARAGRAPH_BOUNDARY = /\n\n+/;

export function createSentenceChunker(): SentenceChunker {
  let buffer = '';

  const drainChunks = (): string[] => {
    const chunks: string[] = [];

    while (buffer.length > 0) {
      const paragraphSplit = splitAtParagraph(buffer);
      if (paragraphSplit) {
        const { chunk, rest } = paragraphSplit;
        if (chunk) chunks.push(...splitOversized(chunk));
        buffer = rest;
        continue;
      }

      const sentenceSplit = splitAtSentence(buffer);
      if (sentenceSplit) {
        const { chunk, rest } = sentenceSplit;
        if (chunk) chunks.push(...splitOversized(chunk));
        buffer = rest;
        continue;
      }

      if (buffer.length >= MAX_CHUNK_CHARS) {
        const forced = buffer.slice(0, MAX_CHUNK_CHARS).trim();
        if (forced) chunks.push(forced);
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
      const chunks = flushSentenceChunks(buffer);
      buffer = '';
      return chunks;
    },
  };
}

export function splitSentenceChunks(text: string): string[] {
  const chunker = createSentenceChunker();
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
