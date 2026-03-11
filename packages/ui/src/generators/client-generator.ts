// ── Typed API Client Generator ──
// Generates typed fetch-based API clients, React hooks, and flow trigger functions
// from capability contracts and flow definitions.

import type { CapabilityContract } from 'plumbus-core';

// ── Generated Client Types ──

export interface ClientGeneratorConfig {
  /** Base URL for API requests (default: "") */
  baseUrl?: string;
  /** Include JSDoc comments in generated code */
  includeJsDoc?: boolean;
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

function httpMethod(kind: string): string {
  return kind === 'query' ? 'GET' : 'POST';
}

function capabilityPath(domain: string, name: string): string {
  return `/api/${domain}/${toKebabCase(name)}`;
}

// ── Type Generators ──

/** Generate TypeScript type placeholders for a capability's input/output */
export function generateCapabilityTypes(cap: CapabilityContract): string {
  const pascal = toPascalCase(cap.name);
  return `export type ${pascal}Input = Record<string, unknown>;
export type ${pascal}Output = Record<string, unknown>;`;
}

// ── Client Function Generator ──

/** Generate a typed fetch-based API client function */
export function generateTypedClient(
  cap: CapabilityContract,
  config?: ClientGeneratorConfig,
): string {
  const fnName = toCamelCase(cap.name);
  const pascal = toPascalCase(cap.name);
  const method = httpMethod(cap.kind);
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
    headers: { "Content-Type": "application/json", ...options?.headers },${fetchBody}
    signal: options?.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.message ?? \`Request failed: \${response.status}\`), {
      status: response.status,
      code: body.code,
      metadata: body.metadata,
    });
  }
  return response.json() as Promise<${pascal}Output>;
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

  return `${jsdoc}export function ${hookName}(input: ${pascal}Input) {
  const [data, setData] = useState<${pascal}Output | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ${fnName}(input)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err : new Error(String(err))); })
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

  return `${jsdoc}export function ${hookName}() {
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
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.message ?? \`Flow start failed: \${response.status}\`), {
      status: response.status,
      code: body.code,
    });
  }
  return response.json() as Promise<{ executionId: string; status: string }>;
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

/** Generate a complete typed client module from capabilities and flows */
export function generateClientModule(
  capabilities: CapabilityContract[],
  flows: FlowTriggerInput[],
  config?: ClientGeneratorConfig,
): string {
  const lines: string[] = [
    '// Auto-generated by @plumbus/ui — do not edit',
    '',
    generateErrorTypes(),
    '',
  ];

  // Type definitions
  for (const cap of capabilities) {
    lines.push(generateCapabilityTypes(cap));
    lines.push('');
  }
  for (const flow of flows) {
    lines.push(`export type ${toPascalCase(flow.name)}FlowInput = Record<string, unknown>;`);
    lines.push('');
  }

  // Client functions
  for (const cap of capabilities) {
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

/** Generate a React hooks module from capabilities */
export function generateHooksModule(
  capabilities: CapabilityContract[],
  config?: ClientGeneratorConfig,
): string {
  const lines: string[] = [
    '// Auto-generated by @plumbus/ui — do not edit',
    'import { useState, useEffect } from "react";',
    '',
  ];

  // Import types from client
  for (const cap of capabilities) {
    const pascal = toPascalCase(cap.name);
    lines.push(`import type { ${pascal}Input, ${pascal}Output } from "./client.js";`);
    lines.push(`import { ${toCamelCase(cap.name)} } from "./client.js";`);
  }
  lines.push('');

  for (const cap of capabilities) {
    lines.push(generateReactHook(cap, config));
    lines.push('');
  }

  return lines.join('\n');
}
