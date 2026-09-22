import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const allowedStringFormats = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

export interface ProviderJsonSchemaResult {
  schema: Record<string, unknown>;
  optionalParameterCount: number;
  unionParameterCount: number;
}

export interface ProviderJsonSchemaOptions {
  promptName?: string;
}

export class ProviderJsonSchemaError extends Error {
  readonly promptName?: string;

  constructor(message: string, promptName?: string) {
    super(promptName ? `${promptName}: ${message}` : message);
    this.name = 'ProviderJsonSchemaError';
    this.promptName = promptName;
  }
}

interface NormalizationState {
  promptName?: string;
  optionalParameterCount: number;
  unionParameterCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, state: NormalizationState): never {
  throw new ProviderJsonSchemaError(message, state.promptName);
}

function appendDescription(schema: Record<string, unknown>, message: string): void {
  const existing = typeof schema.description === 'string' ? schema.description.trim() : '';
  schema.description = existing ? `${existing} ${message}` : message;
}

function stripConstraint(
  schema: Record<string, unknown>,
  key: string,
  describe: (value: unknown) => string,
): void {
  if (!(key in schema)) return;
  appendDescription(schema, describe(schema[key]));
  delete schema[key];
}

function isPrimitiveEnumValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function hasUnsupportedRegex(pattern: string): boolean {
  return (
    /\\[1-9]/.test(pattern) ||
    /\(\?[:=!<]/.test(pattern) ||
    /\\[bB]/.test(pattern) ||
    /\{\d{4,}(?:,\d*)?\}/.test(pattern) ||
    /\{\d+,\d{4,}\}/.test(pattern)
  );
}

function normalizeArray(value: unknown[], path: string, state: NormalizationState): unknown[] {
  return value.map((item, index) => normalizeSchemaNode(item, `${path}[${index}]`, state));
}

function normalizeSchemaNode(value: unknown, path: string, state: NormalizationState): unknown {
  if (typeof value === 'boolean') {
    fail(`boolean JSON Schema nodes are not supported at ${path}`, state);
  }
  if (Array.isArray(value)) {
    return normalizeArray(value, path, state);
  }
  if (!isRecord(value)) {
    return value;
  }

  const schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    schema[key] = child;
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) fail(`empty enum is not supported at ${path}`, state);
    if (!schema.enum.every(isPrimitiveEnumValue)) {
      fail(`enum values must be primitive at ${path}`, state);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 0) fail(`empty anyOf is not supported at ${path}`, state);
    state.unionParameterCount += 1;
    schema.anyOf = normalizeArray(schema.anyOf, `${path}.anyOf`, state);
  }

  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.length === 0) fail(`empty oneOf is not supported at ${path}`, state);
    state.unionParameterCount += 1;
    schema.anyOf = normalizeArray(schema.oneOf, `${path}.oneOf`, state);
    delete schema.oneOf;
  }

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      if (isRecord(child) && '$ref' in child) {
        fail(`allOf with $ref is not supported at ${path}`, state);
      }
    }
    schema.allOf = normalizeArray(schema.allOf, `${path}.allOf`, state);
  }

  if (Array.isArray(schema.type)) {
    state.unionParameterCount += 1;
  }

  if (schema.type === 'object' || isRecord(schema.properties)) {
    schema.type = 'object';
    if ('additionalProperties' in schema && schema.additionalProperties !== false) {
      fail(`additionalProperties must be false at ${path}`, state);
    }
    schema.additionalProperties = false;

    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? new Set(schema.required.filter((key): key is string => typeof key === 'string'))
      : new Set<string>();

    const normalizedProperties: Record<string, unknown> = {};
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!required.has(propertyName)) {
        state.optionalParameterCount += 1;
      }
      normalizedProperties[propertyName] = normalizeSchemaNode(
        propertySchema,
        `${path}.properties.${propertyName}`,
        state,
      );
    }
    schema.properties = normalizedProperties;
    if (required.size > 0) {
      schema.required = [...required];
    } else {
      delete schema.required;
    }
  }

  if (schema.type === 'array' || 'items' in schema || 'prefixItems' in schema) {
    if (Array.isArray(schema.items)) {
      schema.prefixItems = normalizeArray(schema.items, `${path}.items`, state);
      delete schema.items;
    } else if ('items' in schema) {
      schema.items = normalizeSchemaNode(schema.items, `${path}.items`, state);
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems = normalizeArray(schema.prefixItems, `${path}.prefixItems`, state);
    }

    if (typeof schema.minItems === 'number' && schema.minItems > 1) {
      appendDescription(schema, `Must contain at least ${schema.minItems} items.`);
      schema.minItems = 1;
    }
    stripConstraint(
      schema,
      'maxItems',
      (constraint) => `Must contain at most ${constraint} items.`,
    );
    delete schema.minContains;
    delete schema.maxContains;
  }

  if (typeof schema.format === 'string' && !allowedStringFormats.has(schema.format)) {
    appendDescription(schema, `Expected string format: ${schema.format}.`);
    delete schema.format;
  }

  if (typeof schema.pattern === 'string' && hasUnsupportedRegex(schema.pattern)) {
    appendDescription(schema, `Must match pattern: ${schema.pattern}.`);
    delete schema.pattern;
  }

  stripConstraint(schema, 'minimum', (constraint) => `Must be at least ${constraint}.`);
  stripConstraint(schema, 'maximum', (constraint) => `Must be at most ${constraint}.`);
  stripConstraint(
    schema,
    'exclusiveMinimum',
    (constraint) => `Must be greater than ${constraint}.`,
  );
  stripConstraint(schema, 'exclusiveMaximum', (constraint) => `Must be less than ${constraint}.`);
  stripConstraint(schema, 'multipleOf', (constraint) => `Must be a multiple of ${constraint}.`);
  stripConstraint(
    schema,
    'minLength',
    (constraint) => `Must be at least ${constraint} characters.`,
  );
  stripConstraint(schema, 'maxLength', (constraint) => `Must be at most ${constraint} characters.`);

  for (const [key, child] of Object.entries(schema)) {
    if (
      key === 'properties' ||
      key === 'items' ||
      key === 'prefixItems' ||
      key === 'anyOf' ||
      key === 'allOf'
    ) {
      continue;
    }
    if (isRecord(child) || Array.isArray(child)) {
      schema[key] = normalizeSchemaNode(child, `${path}.${key}`, state);
    }
  }

  return schema;
}

export function zodToProviderJsonSchema(
  zodSchema: z.ZodTypeAny,
  options: ProviderJsonSchemaOptions = {},
): ProviderJsonSchemaResult {
  const raw = zodToJsonSchema(zodSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });

  const state: NormalizationState = {
    promptName: options.promptName,
    optionalParameterCount: 0,
    unionParameterCount: 0,
  };
  const normalized = normalizeSchemaNode(raw, '#', state);

  if (!isRecord(normalized)) {
    fail('top-level schema must be an object', state);
  }
  if (state.optionalParameterCount > 24) {
    fail(
      `structured-output schema has ${state.optionalParameterCount} optional parameters; Anthropic limit is 24`,
      state,
    );
  }
  if (state.unionParameterCount > 16) {
    fail(
      `structured-output schema has ${state.unionParameterCount} union parameters; Anthropic limit is 16`,
      state,
    );
  }

  return {
    schema: normalized,
    optionalParameterCount: state.optionalParameterCount,
    unionParameterCount: state.unionParameterCount,
  };
}
