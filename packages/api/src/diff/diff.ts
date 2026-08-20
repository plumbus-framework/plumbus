import { diffOperationSchemas } from './schema-diff.js';
import type { DiffEntry, OpenApiDocument } from '../openapi/types.js';

/** Path-item keys that hold an operation. Everything else (`parameters`, `summary`,
 *  `description`, `servers`, `$ref`) is path-item metadata, not an operation. */
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function operations(
  doc: OpenApiDocument,
): Map<string, { path: string; method: string; op: Record<string, unknown> }> {
  const map = new Map<string, { path: string; method: string; op: Record<string, unknown> }>();
  // `paths` is required in OpenAPI 3.0 but optional in 3.1 (a document may describe only
  // webhooks or components), so a missing object is an empty operation set, not a crash.
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object') {
    return map;
  }
  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') {
      continue;
    }
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }
      if (!op || typeof op !== 'object') {
        continue;
      }
      const operation = op as Record<string, unknown>;
      const id = (operation.operationId as string) ?? `${method}:${path}`;
      map.set(id, { path, method, op: operation });
    }
  }
  return map;
}

/**
 * Report a change of the `openapi` field — always as non-breaking.
 *
 * The `openapi` field names the **document dialect**, not the contract the server serves.
 * Re-emitting the same capabilities as 3.1.0 instead of 3.0.3 leaves every path, method, status
 * code, security requirement and JSON payload identical: no partner request that worked against
 * the 3.0 document stops working against the 3.1 one. The wire contract is unchanged, so the
 * change is not breaking.
 *
 * It is still reported, because the document's *consumers* are affected: a client generator or
 * portal pinned to OpenAPI 3.0 may refuse a 3.1 document, and 3.1 spells nullability, examples
 * and single-value constants differently. That is a publishing decision the release notes should
 * carry, which is exactly what the non-breaking list is for.
 */
function diffDocumentVersion(prev: OpenApiDocument, next: OpenApiDocument): DiffEntry[] {
  const prevVersion = typeof prev.openapi === 'string' ? prev.openapi : undefined;
  const nextVersion = typeof next.openapi === 'string' ? next.openapi : undefined;
  if (prevVersion === nextVersion) {
    return [];
  }
  return [
    {
      kind: 'changed-openapi-version',
      message: `OpenAPI document version changed ${prevVersion ?? 'unknown'} → ${nextVersion ?? 'unknown'} (document dialect only — the wire contract is unchanged; regenerate clients with tooling that reads ${nextVersion ?? 'the new version'})`,
    },
  ];
}

export function diffOpenApi(
  prev: OpenApiDocument,
  next: OpenApiDocument,
): { breaking: DiffEntry[]; nonBreaking: DiffEntry[] } {
  const breaking: DiffEntry[] = [];
  const nonBreaking: DiffEntry[] = [...diffDocumentVersion(prev, next)];
  const prevOps = operations(prev);
  const nextOps = operations(next);

  for (const [id, prevEntry] of prevOps) {
    const nextEntry = nextOps.get(id);
    if (!nextEntry) {
      breaking.push({
        kind: 'removed-operation',
        message: `Removed operation ${id}`,
        path: prevEntry.path,
        operationId: id,
      });
      continue;
    }

    if (prevEntry.method !== nextEntry.method) {
      breaking.push({
        kind: 'changed-method',
        message: `Method changed for ${id}: ${prevEntry.method} → ${nextEntry.method}`,
        path: prevEntry.path,
        operationId: id,
      });
    }

    if (prevEntry.path !== nextEntry.path) {
      breaking.push({
        kind: 'changed-path',
        message: `Path changed for ${id}: ${prevEntry.path} → ${nextEntry.path}`,
        path: prevEntry.path,
        operationId: id,
      });
    }

    const prevDeprecated = prevEntry.op.deprecated === true;
    const nextDeprecated = nextEntry.op.deprecated === true;
    if (!prevDeprecated && nextDeprecated) {
      nonBreaking.push({
        kind: 'deprecated-operation',
        message: `Operation ${id} marked deprecated`,
        operationId: id,
      });
    }

    if (prevEntry.op['x-plumbus-test'] && !nextEntry.op['x-plumbus-test']) {
      breaking.push({
        kind: 'removed-test-behavior',
        message: `Test behavior removed from ${id}`,
        operationId: id,
      });
    }

    const schemaDiff = diffOperationSchemas(id, prevEntry.op, nextEntry.op);
    breaking.push(...schemaDiff.breaking);
    nonBreaking.push(...schemaDiff.nonBreaking);
  }

  for (const [id, nextEntry] of nextOps) {
    if (!prevOps.has(id)) {
      nonBreaking.push({
        kind: 'added-operation',
        message: `Added operation ${id}`,
        path: nextEntry.path,
        operationId: id,
      });
    }
  }

  return { breaking, nonBreaking };
}
