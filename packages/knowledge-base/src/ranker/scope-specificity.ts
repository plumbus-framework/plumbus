import type { ScoredBlock } from '../types/result.js';
import type { KnowledgeScope } from '../types/scope.js';
function countMatchingDimensions(
  blockScope: KnowledgeScope | undefined,
  requested: KnowledgeScope,
): number {
  if (!blockScope) return 0;
  let count = 0;
  if (blockScope.audience !== undefined && blockScope.audience === requested.audience) {
    count += 1;
  }
  if (blockScope.locale !== undefined && blockScope.locale === requested.locale) {
    count += 1;
  }
  if (blockScope.tenantId !== undefined && blockScope.tenantId === requested.tenantId) {
    count += 1;
  }
  if (blockScope.custom && requested.custom) {
    for (const [key, value] of Object.entries(blockScope.custom)) {
      if (requested.custom[key] === value) count += 1;
    }
  }
  return count;
}

function blockMatchesScope(
  blockScope: KnowledgeScope | undefined,
  requested: KnowledgeScope,
): boolean {
  if (!blockScope) return true;
  if (blockScope.audience !== undefined && blockScope.audience !== requested.audience) {
    return false;
  }
  if (blockScope.locale !== undefined && blockScope.locale !== requested.locale) {
    return false;
  }
  if (blockScope.tenantId !== undefined && blockScope.tenantId !== requested.tenantId) {
    return false;
  }
  if (blockScope.custom) {
    for (const [key, value] of Object.entries(blockScope.custom)) {
      if (requested.custom?.[key] !== value) return false;
    }
  }
  return true;
}

export function scopeSpecificityRanker(
  blocks: ScoredBlock[],
  scope: KnowledgeScope,
): ScoredBlock[] {
  const filtered = blocks.filter((b) => blockMatchesScope(b.scope, scope));
  return [...filtered].sort((a, b) => {
    const scoreDiff =
      countMatchingDimensions(b.scope, scope) - countMatchingDimensions(a.scope, scope);
    if (scoreDiff !== 0) return scoreDiff;
    return b.score - a.score;
  });
}

export function filterBlocksByScope(blocks: ScoredBlock[], scope: KnowledgeScope): ScoredBlock[] {
  return blocks.filter((b) => blockMatchesScope(b.scope, scope));
}

export { blockMatchesScope, countMatchingDimensions };
