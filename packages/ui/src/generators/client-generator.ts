// ── Typed API Client Generator ──
// Generates typed fetch-based API clients, React hooks, and flow trigger functions
// from capability contracts and flow definitions.

import { capabilityHttpMethod, isApiExposed, type CapabilityContract } from '@plumbus/core';

/** Fetch/hook wrappers target HTTP routes. Operator-only capabilities are not `exposeAs: ['api']`. */
function httpApiCapabilities(capabilities: CapabilityContract[]): CapabilityContract[] {
  return capabilities.filter((cap) => isApiExposed(cap) && cap.kind !== 'eventHandler');
}

// ── Generated Client Types ──

export type ClientAuthTransport = 'session' | 'bearer';

export interface ClientGeneratorConfig {
  /** Base URL for API requests (default: "") */
  baseUrl?: string;
  /** Include JSDoc comments in generated code */
  includeJsDoc?: boolean;
  /** Toast library import path (default: "sonner") */
  toastImport?: string;
  /** Auth transport for generated fetch clients */
  authTransport?: ClientAuthTransport;
  /**
   * Import path for the auth helper module (default: "./auth", suited to bundler
   * resolution). Targets using node16/nodenext resolution must pass "./auth.js".
   */
  authModuleImport?: string;
}

// ── Helpers ──

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function toPascalCase(str: string): string {
  return str.replace(/(^|[-_ ])(\w)/g, (_, _sep: string, c: string) => c.toUpperCase());
}

function toCamelCase(str: string): string {
  const pc = toPascalCase(str);
  return pc.charAt(0).toLowerCase() + pc.slice(1);
}

/** Client export name for a capability (matches `generateTypedClient`). */
export function capabilityClientFnName(cap: Pick<CapabilityContract, 'name'>): string {
  return toCamelCase(cap.name);
}

/** Client export name for a flow trigger (matches `generateFlowTrigger`). */
export function flowTriggerFnName(flow: FlowTriggerInput): string {
  return `start${toPascalCase(flow.name)}`;
}

/** The declared method where a capability states one; the kind's default otherwise. */
function httpMethod(cap: CapabilityContract): string {
  return capabilityHttpMethod(cap);
}

function capabilityPath(domain: string, name: string): string {
  return `/api/${domain}/${toKebabCase(name)}`;
}

// The specifier is emitted verbatim because the correct form depends on the consuming
// target. The default suits the Next.js template (`moduleResolution: "bundler"`), where a
// `.js` suffix is unresolvable — Turbopack has no `extensionAlias`, so `./auth.js` never
// matches `auth.ts` (vercel/next.js#82945). Targets compiled with node16/nodenext (the
// browser-extension scaffold) must pass an explicit `./auth.js`.
function authImportPath(config?: ClientGeneratorConfig): string {
  return config?.authModuleImport ?? './auth';
}

/**
 * The success envelope, removed where the client meets it.
 *
 * A route answers `{ data: <capability output> }` (`route-generator.ts`), and a partner API route
 * answers `{ ok, data, meta }`. Both are deliberate and stay on the wire — the OpenAPI documents
 * describe them, and the SDKs generated from those documents depend on them.
 *
 * What a *caller of this client* is handed, though, must be the output its return type promises.
 * Returning the envelope under an unenveloped type is a lie the compiler cannot catch: every
 * property access type-checks and every one of them is `undefined` at run time. So the envelope
 * comes off here, in the generated client, once — rather than in each application, where an
 * unwrapping wrapper would be a re-implementation of the client each app has to keep in step.
 *
 * A body is an envelope only when it carries `data` **and** nothing beyond the envelope's own
 * keys. A capability whose output has a `data` field of its own alongside anything else is
 * therefore passed through untouched, which is the conservative half of the ambiguity: a payload
 * that is genuinely `{ data: ... }` and nothing else is indistinguishable from an envelope, and
 * unwrapping it is the same answer the platform's own callers already assume.
 */
const UNWRAP_ENVELOPE_HELPER = `const ENVELOPE_KEYS = new Set(["data", "ok", "meta"]);

function unwrapEnvelope<T>(body: unknown): T {
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "data" in body &&
    Object.keys(body).every((key) => ENVELOPE_KEYS.has(key))
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}`;

function generateClientFetchHelpers(config?: ClientGeneratorConfig): string {
  const transport = config?.authTransport ?? 'bearer';
  const authImport = authImportPath(config);
  if (transport === 'session') {
    return `import { csrfHeaders } from "${authImport}";

function clientFetchInit(
  method: string,
  headers?: Record<string, string>,
): { credentials: RequestCredentials; headers: Record<string, string> } {
  return {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...csrfHeaders(method),
      ...headers,
    },
  };
}

${UNWRAP_ENVELOPE_HELPER}`;
  }

  return `import { getAuthHeaders } from "${authImport}";

function clientFetchInit(
  method: string,
  headers?: Record<string, string>,
): { headers: Record<string, string> } {
  return {
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...headers,
    },
  };
}

${UNWRAP_ENVELOPE_HELPER}`;
}

// ── Zod Schema → TypeScript Type String ──

function getZodDef(schema: unknown): Record<string, unknown> | null {
  if (schema && typeof schema === 'object' && '_def' in schema) {
    return (schema as Record<string, unknown>)._def as Record<string, unknown>;
  }
  return null;
}

function zodSchemaToTypeString(
  schema: unknown,
  indent = '',
  mode: 'input' | 'output' = 'input',
): string {
  const def = getZodDef(schema);
  if (!def) return 'unknown';

  const typeName = typeof def.typeName === 'string' ? def.typeName : 'ZodUnknown';

  switch (typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
    case 'ZodBigInt':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodDate':
      return 'string';
    case 'ZodLiteral':
      return typeof def.value === 'string' ? `"${def.value}"` : String(def.value);
    case 'ZodEnum':
      if (Array.isArray(def.values)) {
        return (def.values as string[]).map((v) => `"${v}"`).join(' | ');
      }
      return 'string';
    case 'ZodNativeEnum':
      return 'string';
    case 'ZodArray': {
      const inner = zodSchemaToTypeString(def.type, indent, mode);
      return inner.includes('|') || inner.includes('{') ? `Array<${inner}>` : `${inner}[]`;
    }
    case 'ZodObject': {
      if (typeof def.shape === 'function') {
        const shape = (def.shape as () => Record<string, unknown>)();
        const entries = Object.entries(shape);
        if (entries.length === 0) return 'Record<string, unknown>';
        const innerIndent = `${indent}  `;
        const fields = entries.map(([key, fieldSchema]) => {
          const optional = isFieldOptional(fieldSchema);
          const innerType = zodSchemaToTypeString(unwrapWrappers(fieldSchema), innerIndent, mode);
          const nullable = isFieldNullable(fieldSchema);
          const typeStr = nullable ? `${innerType} | null` : innerType;
          return `${innerIndent}${key}${optional ? '?' : ''}: ${typeStr};`;
        });
        return `{\n${fields.join('\n')}\n${indent}}`;
      }
      return 'Record<string, unknown>';
    }
    case 'ZodRecord': {
      const valueType = def.valueType
        ? zodSchemaToTypeString(def.valueType, indent, mode)
        : 'unknown';
      return `Record<string, ${valueType}>`;
    }
    case 'ZodOptional':
      return zodSchemaToTypeString(def.innerType, indent, mode);
    case 'ZodNullable': {
      const inner = zodSchemaToTypeString(def.innerType, indent, mode);
      return `${inner} | null`;
    }
    case 'ZodDefault':
      return zodSchemaToTypeString(def.innerType, indent, mode);
    case 'ZodEffects': {
      // Resolve effects by input/output position. Refinements (.refine/.superRefine)
      // leave the type unchanged, so the source schema is correct in either position.
      // A transform's output is its function's return value (which Zod does not expose
      // statically) → emit `unknown` for output, source schema for input. z.preprocess
      // accepts `unknown` as input → emit `unknown` for input, inner schema for output.
      const effect = def.effect as { type?: string } | undefined;
      if (effect?.type === 'transform') {
        return mode === 'output' ? 'unknown' : zodSchemaToTypeString(def.schema, indent, mode);
      }
      if (effect?.type === 'preprocess') {
        return mode === 'input' ? 'unknown' : zodSchemaToTypeString(def.schema, indent, mode);
      }
      return zodSchemaToTypeString(def.schema, indent, mode);
    }
    case 'ZodUnion': {
      if (Array.isArray(def.options)) {
        return (def.options as unknown[])
          .map((o) => zodSchemaToTypeString(o, indent, mode))
          .join(' | ');
      }
      return 'unknown';
    }
    case 'ZodAny':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function isFieldOptional(schema: unknown): boolean {
  const def = getZodDef(schema);
  if (!def) return false;
  const tn = typeof def.typeName === 'string' ? def.typeName : '';
  if (tn === 'ZodOptional' || tn === 'ZodDefault') return true;
  if (tn === 'ZodNullable' && def.innerType) return isFieldOptional(def.innerType);
  // See through .refine/.superRefine/.transform wrappers to the source schema so a
  // field like `z.string().optional().superRefine(...)` is still emitted optional.
  if (tn === 'ZodEffects' && def.schema) return isFieldOptional(def.schema);
  return false;
}

/**
 * Whether a field may be `null`, seen through the wrappers a schema author writes around it.
 *
 * `.nullable()` and `.optional()` compose in either order, and the idiomatic order for "may be
 * omitted, and may be sent as null to clear it" is `.nullable().optional()` — which puts
 * `ZodOptional` outermost. A flat check on the outer type name therefore reported such a field as
 * non-nullable, and the generated client typed it `string | undefined`: the capability accepted a
 * `null` that no caller of the client could construct, so a clearable field became write-only.
 *
 * This recurses the same way `isFieldOptional` does, and for the same reason.
 */
function isFieldNullable(schema: unknown): boolean {
  const def = getZodDef(schema);
  if (!def) return false;
  const tn = typeof def.typeName === 'string' ? def.typeName : '';
  if (tn === 'ZodNullable') return true;
  if ((tn === 'ZodOptional' || tn === 'ZodDefault') && def.innerType) {
    return isFieldNullable(def.innerType);
  }
  // See through .refine/.superRefine/.transform to the source schema, as above.
  if (tn === 'ZodEffects' && def.schema) return isFieldNullable(def.schema);
  return false;
}

function unwrapWrappers(schema: unknown): unknown {
  const def = getZodDef(schema);
  if (!def) return schema;
  const tn = typeof def.typeName === 'string' ? def.typeName : '';
  if (tn === 'ZodOptional' || tn === 'ZodDefault' || tn === 'ZodNullable') {
    return unwrapWrappers(def.innerType);
  }
  return schema;
}

// ── Type Generators ──

/** Generate TypeScript types from a capability's Zod input/output schemas */
export function generateCapabilityTypes(cap: CapabilityContract): string {
  const pascal = toPascalCase(cap.name);
  const inputType = zodSchemaToTypeString(cap.input, '', 'input');
  const outputType = zodSchemaToTypeString(cap.output, '', 'output');
  return `export type ${pascal}Input = ${inputType};
export type ${pascal}Output = ${outputType};`;
}

// ── Client Function Generator ──

/** Generate a typed fetch-based API client function */
export function generateTypedClient(
  cap: CapabilityContract,
  config?: ClientGeneratorConfig,
): string {
  const fnName = toCamelCase(cap.name);
  const pascal = toPascalCase(cap.name);
  const method = httpMethod(cap);
  const urlPath = capabilityPath(cap.domain, cap.name);
  const base = config?.baseUrl ?? '';

  const jsdoc = config?.includeJsDoc
    ? `/** ${cap.description ?? `${cap.kind} — ${cap.name}`} */\n`
    : '';

  const queryParams =
    method === 'GET'
      ? `\n  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  const url = qs ? \`${base}${urlPath}?\${qs}\` : "${base}${urlPath}";`
      : '';

  const fetchUrl = method === 'GET' ? 'url' : `"${base}${urlPath}"`;
  const fetchBody = method === 'GET' ? '' : `\n    body: JSON.stringify(input),`;

  return `${jsdoc}export async function ${fnName}(
  input: ${pascal}Input,
  options?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<${pascal}Output> {${queryParams}
  const response = await fetch(${fetchUrl}, {
    method: "${method}",
    ...clientFetchInit("${method}", options?.headers),${fetchBody}
    signal: options?.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err = body.error ?? body;
    throw Object.assign(new Error(err.message ?? \`Request failed: \${response.status}\`), {
      status: response.status,
      code: err.code,
      metadata: err.metadata,
    });
  }
  return unwrapEnvelope<${pascal}Output>(await response.json());
}`;
}

// ── React Hook Generator ──

/** Generate a React hook for a query capability */
export function generateQueryHook(cap: CapabilityContract, config?: ClientGeneratorConfig): string {
  const hookName = `use${toPascalCase(cap.name)}`;
  const fnName = toCamelCase(cap.name);
  const pascal = toPascalCase(cap.name);
  const jsdoc = config?.includeJsDoc
    ? `/** Hook for ${cap.description ?? cap.name} (query) */\n`
    : '';

  return `${jsdoc}export function ${hookName}(input: ${pascal}Input, options?: { onError?: (err: Error) => void }) {
  const [data, setData] = useState<${pascal}Output | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ${fnName}(input)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => {
        if (cancelled) return;
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        if (options?.onError) options.onError(e);
        else toast.error(e.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [JSON.stringify(input)]);

  return { data, loading, error };
}`;
}

/** Generate a React hook for a mutation capability (action/job) */
export function generateMutationHook(
  cap: CapabilityContract,
  config?: ClientGeneratorConfig,
): string {
  const hookName = `use${toPascalCase(cap.name)}`;
  const fnName = toCamelCase(cap.name);
  const pascal = toPascalCase(cap.name);
  const jsdoc = config?.includeJsDoc
    ? `/** Hook for ${cap.description ?? cap.name} (${cap.kind}) */\n`
    : '';

  return `${jsdoc}export function ${hookName}(options?: { onError?: (err: Error) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<${pascal}Output | null>(null);

  const mutate = async (input: ${pascal}Input) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ${fnName}(input);
      setData(result);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      if (options?.onError) options.onError(err);
      else toast.error(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const reset = () => { setData(null); setError(null); };

  return { mutate, data, loading, error, reset };
}`;
}

/** Generate the appropriate hook based on capability kind */
export function generateReactHook(cap: CapabilityContract, config?: ClientGeneratorConfig): string {
  return cap.kind === 'query' ? generateQueryHook(cap, config) : generateMutationHook(cap, config);
}

// ── Flow Trigger Generator ──

export interface FlowTriggerInput {
  name: string;
  domain?: string;
  description?: string;
}

/** Generate a flow trigger function */
export function generateFlowTrigger(
  flow: FlowTriggerInput,
  config?: ClientGeneratorConfig,
): string {
  const fnName = `start${toPascalCase(flow.name)}`;
  const pascal = toPascalCase(flow.name);
  const base = config?.baseUrl ?? '';
  const domain = flow.domain ?? 'flows';
  const urlPath = `/api/${domain}/${toKebabCase(flow.name)}/start`;

  const jsdoc = config?.includeJsDoc ? `/** Start flow: ${flow.description ?? flow.name} */\n` : '';

  return `${jsdoc}export async function ${fnName}(
  input: ${pascal}FlowInput,
  options?: { headers?: Record<string, string> },
): Promise<{ executionId: string; status: string }> {
  const response = await fetch("${base}${urlPath}", {
    method: "POST",
    ...clientFetchInit("POST", options?.headers),
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err = body.error ?? body;
    throw Object.assign(new Error(err.message ?? \`Flow start failed: \${response.status}\`), {
      status: response.status,
      code: err.code,
    });
  }
  return unwrapEnvelope<{ executionId: string; status: string }>(await response.json());
}`;
}

// ── Response/Error Types ──

/** Generate common response and error types */
export function generateErrorTypes(): string {
  return `export interface PlumbusApiError {
  status: number;
  code?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export function isPlumbusApiError(error: unknown): error is PlumbusApiError {
  return typeof error === "object" && error !== null && "status" in error && "message" in error;
}`;
}

// ── Full Client Module Generator ──

/**
 * Generate a complete typed client module from capabilities and flows.
 * Only capabilities with `exposeAs: ['api']` get fetch wrappers (event handlers never do).
 */
export function generateClientModule(
  capabilities: CapabilityContract[],
  flows: FlowTriggerInput[],
  config?: ClientGeneratorConfig,
): string {
  const httpCapabilities = httpApiCapabilities(capabilities);
  const lines: string[] = [
    '// Auto-generated by @plumbus/ui — do not edit',
    '',
    generateErrorTypes(),
    '',
    generateClientFetchHelpers(config),
    '',
  ];

  // Type definitions
  for (const cap of httpCapabilities) {
    lines.push(generateCapabilityTypes(cap));
    lines.push('');
  }
  for (const flow of flows) {
    lines.push(`export type ${toPascalCase(flow.name)}FlowInput = Record<string, unknown>;`);
    lines.push('');
  }

  // Client functions
  for (const cap of httpCapabilities) {
    lines.push(generateTypedClient(cap, config));
    lines.push('');
  }

  // Flow triggers
  for (const flow of flows) {
    lines.push(generateFlowTrigger(flow, config));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a React hooks module from capabilities.
 * Only capabilities with `exposeAs: ['api']` get hooks (event handlers never do).
 */
export function generateHooksModule(
  capabilities: CapabilityContract[],
  config?: ClientGeneratorConfig,
): string {
  const httpCapabilities = httpApiCapabilities(capabilities);
  const toastPkg = config?.toastImport ?? 'sonner';
  const lines: string[] = [
    '// Auto-generated by @plumbus/ui — do not edit',
    'import { useState, useEffect } from "react";',
    `import { toast } from "${toastPkg}";`,
    '',
  ];

  // Import types from client
  for (const cap of httpCapabilities) {
    const pascal = toPascalCase(cap.name);
    lines.push(`import type { ${pascal}Input, ${pascal}Output } from "../lib/client";`);
    lines.push(`import { ${toCamelCase(cap.name)} } from "../lib/client";`);
  }
  lines.push('');

  for (const cap of httpCapabilities) {
    lines.push(generateReactHook(cap, config));
    lines.push('');
  }

  return lines.join('\n');
}
