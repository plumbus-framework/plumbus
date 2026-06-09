import { diffOperationSchemas } from './schema-diff.js';
import type { DiffEntry, OpenApiDocument } from '../openapi/types.js';

function operations(
  doc: OpenApiDocument,
): Map<string, { path: string; method: string; op: Record<string, unknown> }> {
  const map = new Map<string, { path: string; method: string; op: Record<string, unknown> }>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const operation = op as Record<string, unknown>;
      const id = (operation.operationId as string) ?? `${method}:${path}`;
      map.set(id, { path, method, op: operation });
    }
  }
  return map;
}

export function diffOpenApi(
  prev: OpenApiDocument,
  next: OpenApiDocument,
): { breaking: DiffEntry[]; nonBreaking: DiffEntry[] } {
  const breaking: DiffEntry[] = [];
  const nonBreaking: DiffEntry[] = [];
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
