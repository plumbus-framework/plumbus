import type { ChatSourceRef, ResolvedContext } from '../types/context.js';

export function issueHandles(resolved: ResolvedContext): Map<string, ChatSourceRef> {
  const map = new Map<string, ChatSourceRef>();
  for (const s of resolved.sources) {
    map.set(s.id, s);
  }
  return map;
}

export function validateCitations(
  citedSourceIds: string[],
  allowed: Set<string>,
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const id of citedSourceIds) {
    if (allowed.has(id)) valid.push(id);
    else invalid.push(id);
  }
  return { valid, invalid };
}

export function stripInvalidFromAnswer(answer: string, invalidIds: string[]): string {
  let out = answer;
  for (const id of invalidIds) {
    out = out.replaceAll(`[src:${id}]`, '');
  }
  return out;
}
