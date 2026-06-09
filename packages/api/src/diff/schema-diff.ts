import type { DiffEntry } from '../openapi/types.js';

type JsonSchema = Record<string, unknown>;

interface ObjectSchemaView {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
}

function asObjectSchema(schema: unknown): ObjectSchemaView | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }
  const s = schema as JsonSchema;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const required = new Set(
      Array.isArray(s.required)
        ? (s.required as string[]).filter((r) => typeof r === 'string')
        : [],
    );
    return { properties: s.properties as Record<string, JsonSchema>, required };
  }
  if (Array.isArray(s.allOf)) {
    for (const part of s.allOf) {
      const partSchema = part as JsonSchema;
      const data = partSchema.properties
        ? (partSchema.properties as Record<string, JsonSchema>).data
        : undefined;
      const fromData = asObjectSchema(data);
      if (fromData) {
        return fromData;
      }
      const direct = asObjectSchema(part);
      if (direct) {
        return direct;
      }
    }
  }
  return undefined;
}

function extractRequestSchema(op: Record<string, unknown>): ObjectSchemaView | undefined {
  const requestBody = op.requestBody as
    | { content?: { 'application/json'?: { schema?: unknown } } }
    | undefined;
  const bodySchema = requestBody?.content?.['application/json']?.schema;
  const fromBody = asObjectSchema(bodySchema);
  if (fromBody) {
    return fromBody;
  }

  const parameters = op.parameters as
    | { in?: string; name?: string; required?: boolean; schema?: unknown }[]
    | undefined;
  if (!parameters?.length) {
    return undefined;
  }

  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  for (const param of parameters) {
    if (param.in !== 'query' || !param.name) {
      continue;
    }
    properties[param.name] = (param.schema ?? { type: 'string' }) as JsonSchema;
    if (param.required) {
      required.add(param.name);
    }
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }
  return { properties, required };
}

function extractResponseDataSchema(op: Record<string, unknown>): ObjectSchemaView | undefined {
  const responses = op.responses as
    | Record<string, { content?: { 'application/json'?: { schema?: unknown } } }>
    | undefined;
  const schema = responses?.['200']?.content?.['application/json']?.schema;
  const top = asObjectSchema(schema);
  if (!top) {
    return undefined;
  }

  const dataField = top.properties.data;
  if (dataField) {
    const dataSchema = asObjectSchema(dataField);
    if (dataSchema) {
      return dataSchema;
    }
  }

  return top;
}

function schemaTypeKey(schema: JsonSchema): string {
  if (schema.enum) {
    return `enum:${JSON.stringify(schema.enum)}`;
  }
  const type = schema.type ?? 'unknown';
  const format = schema.format ? `:${schema.format}` : '';
  return `${String(type)}${format}`;
}

function compareObjectSchemas(
  prev: ObjectSchemaView,
  next: ObjectSchemaView,
  operationId: string,
  direction: 'request' | 'response',
): { breaking: DiffEntry[]; nonBreaking: DiffEntry[] } {
  const breaking: DiffEntry[] = [];
  const nonBreaking: DiffEntry[] = [];

  for (const [name, prevField] of Object.entries(prev.properties)) {
    const nextField = next.properties[name];
    if (!nextField) {
      const kind = direction === 'response' ? 'removed-response-field' : 'removed-request-field';
      const severity = direction === 'response' ? 'breaking' : 'non-breaking';
      const entry: DiffEntry = {
        kind,
        message: `${direction} field "${name}" removed from ${operationId}`,
        operationId,
      };
      if (severity === 'breaking') {
        breaking.push(entry);
      } else {
        nonBreaking.push(entry);
      }
      continue;
    }

    if (schemaTypeKey(prevField) !== schemaTypeKey(nextField)) {
      breaking.push({
        kind: direction === 'response' ? 'changed-response-type' : 'changed-request-type',
        message: `${direction} field "${name}" type changed in ${operationId}`,
        operationId,
      });
    }

    const prevEnum = Array.isArray(prevField.enum) ? (prevField.enum as unknown[]) : undefined;
    const nextEnum = Array.isArray(nextField.enum) ? (nextField.enum as unknown[]) : undefined;
    if (prevEnum && nextEnum) {
      const removed = prevEnum.filter((v) => !nextEnum.includes(v));
      if (removed.length > 0) {
        breaking.push({
          kind: 'enum-value-removed',
          message: `Enum values removed from "${name}" in ${operationId}: ${removed.join(', ')}`,
          operationId,
        });
      }
    }
  }

  for (const name of Object.keys(next.properties)) {
    if (prev.properties[name]) {
      continue;
    }
    const isRequired = next.required.has(name);
    const kind =
      direction === 'response'
        ? isRequired
          ? 'added-required-response-field'
          : 'added-optional-response-field'
        : isRequired
          ? 'added-required-input'
          : 'added-optional-input';
    const entry: DiffEntry = {
      kind,
      message: `${direction} field "${name}" added to ${operationId}${isRequired ? ' (required)' : ''}`,
      operationId,
    };
    if (direction === 'request' && isRequired) {
      breaking.push(entry);
    } else {
      nonBreaking.push(entry);
    }
  }

  for (const name of next.required) {
    if (!prev.required.has(name) && prev.properties[name]) {
      const entry: DiffEntry = {
        kind:
          direction === 'response'
            ? 'response-field-became-required'
            : 'request-field-became-required',
        message: `${direction} field "${name}" became required in ${operationId}`,
        operationId,
      };
      if (direction === 'request') {
        breaking.push(entry);
      } else {
        nonBreaking.push(entry);
      }
    }
  }

  return { breaking, nonBreaking };
}

function extractOAuthScopes(op: Record<string, unknown>): string[] {
  const security = op.security as { oauth2?: string[] }[] | undefined;
  return security?.[0]?.oauth2 ?? [];
}

function errorResponseShape(op: Record<string, unknown>): string {
  const codes = ['400', '401', '403', '404', '409', '500'];
  const responses = op.responses as Record<string, { description?: string }> | undefined;
  return codes.map((c) => (responses?.[c] ? '1' : '0')).join('');
}

export function diffOperationSchemas(
  operationId: string,
  prevOp: Record<string, unknown>,
  nextOp: Record<string, unknown>,
): { breaking: DiffEntry[]; nonBreaking: DiffEntry[] } {
  const breaking: DiffEntry[] = [];
  const nonBreaking: DiffEntry[] = [];

  const prevRequest = extractRequestSchema(prevOp);
  const nextRequest = extractRequestSchema(nextOp);
  if (prevRequest && nextRequest) {
    const requestDiff = compareObjectSchemas(prevRequest, nextRequest, operationId, 'request');
    breaking.push(...requestDiff.breaking);
    nonBreaking.push(...requestDiff.nonBreaking);
  }

  const prevResponse = extractResponseDataSchema(prevOp);
  const nextResponse = extractResponseDataSchema(nextOp);
  if (prevResponse && nextResponse) {
    const responseDiff = compareObjectSchemas(prevResponse, nextResponse, operationId, 'response');
    breaking.push(...responseDiff.breaking);
    nonBreaking.push(...responseDiff.nonBreaking);
  }

  const prevScopes = extractOAuthScopes(prevOp);
  const nextScopes = extractOAuthScopes(nextOp);
  for (const scope of nextScopes) {
    if (!prevScopes.includes(scope)) {
      breaking.push({
        kind: 'tightened-scopes',
        message: `Scope "${scope}" added to ${operationId}`,
        operationId,
      });
    }
  }

  if (errorResponseShape(prevOp) !== errorResponseShape(nextOp)) {
    breaking.push({
      kind: 'changed-error-shape',
      message: `Error response shape changed for ${operationId}`,
      operationId,
    });
  }

  return { breaking, nonBreaking };
}
