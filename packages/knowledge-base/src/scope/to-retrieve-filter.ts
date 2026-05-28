import type { KnowledgeScope } from '../types/scope.js';

export function scopeToRetrieveFilter(scope: KnowledgeScope): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (scope.audience) flat.audience = scope.audience;
  if (scope.locale) flat.locale = scope.locale;
  if (scope.tenantId) flat.tenantId = scope.tenantId;
  if (scope.custom) Object.assign(flat, scope.custom);
  return flat;
}
