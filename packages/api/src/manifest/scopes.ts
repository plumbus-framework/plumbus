/** Union manifest auth scopes with capability access scopes (runtime + OpenAPI parity). */
export function requiredApiScopes(
  resolvedScopes: readonly string[] | undefined,
  accessScopes: readonly string[] | undefined,
): string[] {
  return [...new Set([...(resolvedScopes ?? []), ...(accessScopes ?? [])])];
}
