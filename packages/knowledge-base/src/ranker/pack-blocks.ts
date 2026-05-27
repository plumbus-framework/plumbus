import type { ScoredBlock } from '../types/result.js';

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function packBlocks(blocks: ScoredBlock[], maxTokens?: number): string {
  if (blocks.length === 0) return '';
  if (maxTokens === undefined || maxTokens <= 0) {
    return blocks.map((b) => b.text).join('\n\n');
  }

  const parts: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);
    const separatorTokens = parts.length > 0 ? 1 : 0;
    if (used + separatorTokens + blockTokens > maxTokens) break;
    parts.push(block.text);
    used += separatorTokens + blockTokens;
  }
  return parts.join('\n\n');
}
