// ── plumbus generate ──
// Auto-generate derived artifacts from contracts

import type { Command } from 'commander';
import * as JSONC from 'jsonc-parser';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { buildMcpManifest, isMcpExposed, renderSkillFile } from '../../mcp/index.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import type { CapabilityKind } from '../../types/enums.js';
import type { EventDefinition } from '../../types/event.js';
import type { FieldDescriptor } from '../../types/fields.js';
import type { FlowDefinition } from '../../types/flow.js';
import { discoverResources } from '../discover.js';
import { jobEventType } from '../../jobs/types.js';
import {
  detectMonorepoLayout,
  exists,
  info,
  resolvePath,
  success,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  warn,
  writeFile,
} from '../utils.js';

export interface GenerateOptions {
  json?: boolean;
}

/**
 * Convert a Zod type to a TypeScript type string for code generation.
 * Handles ZodObject (with nested shapes), ZodArray, ZodString, ZodNumber,
 * ZodBoolean, ZodEnum, ZodOptional, ZodNullable, ZodDefault, and ZodLiteral.
 * Falls back to `unknown` for unsupported types.
 */
export function zodTypeToString(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const entries = Object.entries(shape);
    if (entries.length === 0) return 'Record<string, never>';
    const fields = entries.map(([key, value]) => {
      const isOptional = value instanceof z.ZodOptional || value instanceof z.ZodDefault;
      return `  ${key}${isOptional ? '?' : ''}: ${zodTypeToString(value)};`;
    });
    return `{\n${fields.join('\n')}\n}`;
  }
  if (schema instanceof z.ZodArray) {
    const inner = zodTypeToString(schema.element);
    return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
  }
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodDate) return 'Date';
  if (schema instanceof z.ZodLiteral) {
    const val = schema.value;
    return typeof val === 'string' ? `"${val}"` : String(val);
  }
  if (schema instanceof z.ZodEnum) {
    const values = schema.options as string[];
    return values.map((v) => `"${v}"`).join(' | ');
  }
  if (schema instanceof z.ZodNativeEnum) return 'string | number';
  if (schema instanceof z.ZodOptional) return zodTypeToString(schema.unwrap());
  if (schema instanceof z.ZodNullable) return `${zodTypeToString(schema.unwrap())} | null`;
  if (schema instanceof z.ZodDefault) return zodTypeToString(schema.removeDefault());
  if (schema instanceof z.ZodUnion) {
    const opts = schema.options as z.ZodTypeAny[];
    return opts.map((o) => zodTypeToString(o)).join(' | ');
  }
  if (schema instanceof z.ZodRecord) return 'Record<string, unknown>';
  if (schema instanceof z.ZodVoid) return 'void';
  if (schema instanceof z.ZodUndefined) return 'undefined';
  if (schema instanceof z.ZodNull) return 'null';
  if (schema instanceof z.ZodAny) return 'any';
  if (schema instanceof z.ZodUnknown) return 'unknown';
  return 'unknown';
}

/** Generate TypeScript type declarations for a capability's input and output */
export function generateCapabilityTypes(cap: CapabilityContract): string {
  const name = toPascalCase(cap.name);
  const inputType = zodTypeToString(cap.input);
  const outputType = zodTypeToString(cap.output);
  return `export type ${name}Input = ${inputType};\nexport type ${name}Output = ${outputType};`;
}

/** Generate a union type of all capability names */
export function generateCapabilityNameType(capabilities: CapabilityContract[]): string {
  if (capabilities.length === 0) {
    return 'export type CapabilityName = never;';
  }
  const names = capabilities.map((c) => `"${c.name}"`).join(' | ');
  return `export type CapabilityName = ${names};`;
}

/** Generate a union type of all event names */
export function generateEventNameType(events: EventDefinition[]): string {
  if (events.length === 0) {
    return 'export type EventName = never;';
  }
  const names = events.map((e) => `"${e.name}"`).join(' | ');
  return `export type EventName = ${names};`;
}

/** Generate a union type of all flow names */
export function generateFlowNameType(flows: FlowDefinition[]): string {
  if (flows.length === 0) {
    return 'export type FlowName = never;';
  }
  const names = flows.map((f) => `"${f.name}"`).join(' | ');
  return `export type FlowName = ${names};`;
}

/**
 * Generate a plumbus.d.ts declaration file that augments PlumbusRegistry
 * with discovered capability names, event names, flow names, and entity mappings.
 */
export function generatePlumbusDeclaration(
  capabilities: CapabilityContract[],
  events: EventDefinition[],
  flows: FlowDefinition[],
  entities: EntityDefinition[],
): string {
  const lines: string[] = [
    '// Auto-generated by `plumbus generate` — do not edit',
    '// This file augments the PlumbusRegistry interface from @plumbus/core',
    '// to provide strict typing for capability names, event names, flow names,',
    '// and entity data access throughout your application.',
    '',
  ];

  // Only import Repository if there are entities to map
  if (entities.length > 0) {
    lines.push('import type { Repository } from "@plumbus/core";');
    for (const entity of entities) {
      const name = toPascalCase(entity.name);
      lines.push(
        `import type { ${name}Record, ${name}CreateInput, ${name}UpdateInput } from "./entity-types.js";`,
      );
    }
    lines.push('');
  }

  lines.push('declare module "@plumbus/core" {');
  lines.push('  interface PlumbusRegistry {');

  // capabilityName
  if (capabilities.length > 0) {
    const capNames = capabilities.map((c) => `"${c.name}"`).join(' | ');
    lines.push(`    capabilityName: ${capNames};`);
  } else {
    lines.push('    capabilityName: never;');
  }

  // eventName
  if (events.length > 0) {
    const evNames = events.map((e) => `"${e.name}"`).join(' | ');
    lines.push(`    eventName: ${evNames};`);
  } else {
    lines.push('    eventName: never;');
  }

  // eventPayloads — maps each event name to its payload type
  if (events.length > 0) {
    lines.push('    eventPayloads: {');
    for (const event of events) {
      const payloadType = zodTypeToString(event.payload);
      lines.push(`      "${event.name}": ${payloadType};`);
    }
    lines.push('    };');
  } else {
    lines.push('    eventPayloads: Record<string, never>;');
  }

  // flowName
  if (flows.length > 0) {
    const flowNames = flows.map((f) => `"${f.name}"`).join(' | ');
    lines.push(`    flowName: ${flowNames};`);
  } else {
    lines.push('    flowName: never;');
  }

  // entities
  if (entities.length > 0) {
    lines.push('    entities: {');
    for (const entity of entities) {
      const name = toPascalCase(entity.name);
      lines.push(
        `      ${entity.name}: Repository<${name}Record, ${name}CreateInput, ${name}UpdateInput>;`,
      );
    }
    lines.push('    };');
  } else {
    lines.push('    entities: Record<string, never>;');
  }

  lines.push('  }');
  lines.push('}');

  return lines.join('\n');
}

/** Generate a typed API client function for a capability */
export function generateClientFunction(cap: CapabilityContract): string {
  const fnName = toCamelCase(cap.name);
  const kind = cap.kind as CapabilityKind;
  const method = kind === 'query' ? 'GET' : 'POST';
  const urlPath = `/api/${cap.domain}/${toKebabCase(cap.name)}`;

  if (method === 'GET') {
    return `export async function ${fnName}(input: ${toPascalCase(cap.name)}Input): Promise<${toPascalCase(cap.name)}Output> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  const response = await fetch(\`${urlPath}\${qs ? \`?\${qs}\` : ""}\`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(\`Request failed: \${response.status}\`);
  return response.json() as Promise<${toPascalCase(cap.name)}Output>;
}`;
  }

  return `export async function ${fnName}(input: ${toPascalCase(cap.name)}Input): Promise<${toPascalCase(cap.name)}Output> {
  const response = await fetch("${urlPath}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(\`Request failed: \${response.status}\`);
  return response.json() as Promise<${toPascalCase(cap.name)}Output>;
}`;
}

/** Generate a React hook for a capability */
export function generateReactHook(cap: CapabilityContract): string {
  const hookName = `use${toPascalCase(cap.name)}`;
  const fnName = toCamelCase(cap.name);
  const kind = cap.kind as CapabilityKind;

  if (kind === 'query') {
    return `export function ${hookName}(input: ${toPascalCase(cap.name)}Input) {
  const [data, setData] = useState<${toPascalCase(cap.name)}Output | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setLoading(true);
    ${fnName}(input).then(setData).catch(setError).finally(() => setLoading(false));
  }, [JSON.stringify(input)]);

  return { data, loading, error };
}`;
  }

  return `export function ${hookName}() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = async (input: ${toPascalCase(cap.name)}Input) => {
    setLoading(true);
    setError(null);
    try {
      return await ${fnName}(input);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      setLoading(false);
    }
  };

  return { mutate, loading, error };
}`;
}

/** Generate an OpenAPI path entry for a capability */
export function generateOpenApiPath(cap: CapabilityContract): Record<string, unknown> {
  const kind = cap.kind as CapabilityKind;
  const method = kind === 'query' ? 'get' : 'post';
  const urlPath = `/api/${cap.domain}/${toKebabCase(cap.name)}`;

  return {
    [urlPath]: {
      [method]: {
        operationId: cap.name,
        summary: cap.description ?? cap.name,
        tags: [cap.domain],
        requestBody:
          method === 'post'
            ? {
                required: true,
                content: { 'application/json': { schema: { type: 'object' } } },
              }
            : undefined,
        responses: {
          '200': {
            description: 'Successful response',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  };
}

/** Generate a manifest entry for a capability */
export function generateManifestEntry(cap: CapabilityContract): Record<string, unknown> {
  return {
    name: cap.name,
    kind: cap.kind,
    domain: cap.domain,
    description: cap.description,
    effects: cap.effects,
    access: cap.access,
  };
}

/**
 * Map an entity FieldDescriptor type to its TypeScript type string.
 */
function fieldTypeToTS(descriptor: FieldDescriptor): string {
  switch (descriptor.type) {
    case 'id':
      return 'string';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'decimal':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'timestamp':
      return 'Date';
    case 'json':
      return 'unknown';
    case 'enum':
      return descriptor.values.map((v) => `"${v}"`).join(' | ') || 'string';
    case 'relation':
      return 'string';
    default:
      return 'unknown';
  }
}

/**
 * Generate a TypeScript interface for a single entity definition.
 */
export function generateEntityInterface(entity: EntityDefinition): string {
  const name = toPascalCase(entity.name);
  const lines: string[] = [];

  lines.push(`export interface ${name}Record {`);
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    const tsType = fieldTypeToTS(descriptor);
    const optional = !descriptor.options.required && descriptor.type !== 'id';
    lines.push(`  ${fieldName}${optional ? '?' : ''}: ${tsType};`);
  }

  // Auto-added fields (mirrors schema-generator.ts behavior)
  if (!entity.fields.createdAt) {
    lines.push('  createdAt: Date;');
  }
  if (!entity.fields.updatedAt) {
    lines.push('  updatedAt: Date;');
  }
  if (entity.tenantScoped && !entity.fields.tenantId) {
    lines.push('  tenantId: string;');
  }

  lines.push('}');

  // Auto-generated fields that should be excluded from create/update inputs
  const systemFields = new Set(['id', 'createdAt', 'updatedAt']);
  if (entity.tenantScoped) {
    systemFields.add('tenantId');
  }

  // CreateInput — omits system-managed fields. Fields with a `default` are
  // optional in the input type even when `required: true`, because the
  // runtime will supply the default when the caller omits them. This keeps
  // CreateInput callers backward-compatible when new required-with-default
  // fields are added to existing entities.
  lines.push('');
  lines.push(`export interface ${name}CreateInput {`);
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (systemFields.has(fieldName)) continue;
    const tsType = fieldTypeToTS(descriptor);
    const hasDefault = descriptor.options.default !== undefined;
    const optional = !descriptor.options.required || hasDefault;
    lines.push(`  ${fieldName}${optional ? '?' : ''}: ${tsType};`);
  }
  lines.push('}');

  // UpdateInput — all non-system fields are optional
  lines.push('');
  lines.push(`export interface ${name}UpdateInput {`);
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (systemFields.has(fieldName)) continue;
    const tsType = fieldTypeToTS(descriptor);
    lines.push(`  ${fieldName}?: ${tsType};`);
  }
  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate a DataServiceMap interface that maps entity names to typed repositories.
 */
export function generateDataServiceMap(entities: EntityDefinition[]): string {
  const lines: string[] = [];
  lines.push('import type { Repository } from "@plumbus/core";');
  lines.push('');

  for (const entity of entities) {
    lines.push(generateEntityInterface(entity));
    lines.push('');
  }

  lines.push('export interface DataServiceMap {');
  for (const entity of entities) {
    const name = toPascalCase(entity.name);
    lines.push(
      `  ${entity.name}: Repository<${name}Record, ${name}CreateInput, ${name}UpdateInput>;`,
    );
  }
  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate the full entity types file content.
 */
export function generateEntityTypeFile(entities: EntityDefinition[]): string {
  const header = '// Auto-generated by `plumbus generate` — do not edit\n';
  if (entities.length === 0) {
    return `${header}\nexport interface DataServiceMap {}\n`;
  }
  return `${header}\n${generateDataServiceMap(entities)}\n`;
}

/** Generate auto-registered queue consumer manifest from capabilities. */
export function generateConsumerManifest(
  capabilities: CapabilityContract[],
): Record<string, unknown>[] {
  const consumers: Record<string, unknown>[] = [];
  for (const cap of capabilities) {
    if (cap.kind === 'eventHandler' && cap.trigger?.event) {
      consumers.push({
        id: cap.name,
        kind: 'eventHandler',
        eventTypes: [cap.trigger.event],
        versionConstraint: cap.trigger.versionConstraint,
      });
    }
    if (cap.kind === 'job') {
      consumers.push({
        id: `job:${cap.domain}:${cap.name}`,
        kind: 'job',
        eventTypes: [jobEventType(cap.domain, cap.name)],
      });
    }
  }
  return consumers;
}

/** Run full code generation for a set of capabilities */
export function generateAll(
  capabilities: CapabilityContract[],
  outputDir: string,
  entities: EntityDefinition[] = [],
  events: EventDefinition[] = [],
  flows: FlowDefinition[] = [],
  sharedTypesDir?: string,
): string[] {
  const generated: string[] = [];

  // Capability types (input/output interfaces + CapabilityName union)
  const capabilityTypeLines = [
    '// Auto-generated by `plumbus generate` — do not edit',
    '',
    ...capabilities.map(generateCapabilityTypes),
    '',
    generateCapabilityNameType(capabilities),
  ];
  writeFile(path.join(outputDir, 'capability-types.ts'), capabilityTypeLines.join('\n\n'));
  generated.push('capability-types.ts');

  // Client functions
  const clientLines = [
    '// Auto-generated by `plumbus generate` — do not edit',
    '',
    ...capabilities.map(
      (c) =>
        `import type { ${toPascalCase(c.name)}Input, ${toPascalCase(c.name)}Output } from "../capability-types.js";`,
    ),
    '',
    ...capabilities.map(generateClientFunction),
  ];
  writeFile(path.join(outputDir, 'clients', 'api.ts'), clientLines.join('\n\n'));
  generated.push('clients/api.ts');

  // React hooks
  const hookLines = [
    '// Auto-generated by `plumbus generate` — do not edit',
    '// biome-ignore-all lint/correctness/noUnusedImports: generated code',
    '// @ts-nocheck',
    'import { useState, useEffect } from "react";',
    ...capabilities.map(
      (c) =>
        `import type { ${toPascalCase(c.name)}Input, ${toPascalCase(c.name)}Output } from "../capability-types.js";`,
    ),
    '',
    ...capabilities.map((c) => {
      const fnName = toCamelCase(c.name);
      return `import { ${fnName} } from "./api.js";`;
    }),
    '',
    ...capabilities.map(generateReactHook),
  ];
  writeFile(path.join(outputDir, 'clients', 'hooks.ts'), hookLines.join('\n\n'));
  generated.push('clients/hooks.ts');

  // OpenAPI spec
  const paths: Record<string, unknown> = {};
  for (const cap of capabilities) {
    Object.assign(paths, generateOpenApiPath(cap));
  }
  const openApi = {
    openapi: '3.0.3',
    info: { title: 'Plumbus API', version: '0.1.0' },
    paths,
  };
  writeFile(path.join(outputDir, 'openapi.json'), JSON.stringify(openApi, null, 2));
  generated.push('openapi.json');

  // Manifest
  const manifest = {
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    capabilities: capabilities.map(generateManifestEntry),
  };
  writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  generated.push('manifest.json');

  const consumerManifest = {
    generatedAt: new Date().toISOString(),
    consumers: generateConsumerManifest(capabilities),
  };
  writeFile(
    path.join(outputDir, 'consumers-manifest.json'),
    JSON.stringify(consumerManifest, null, 2),
  );
  generated.push('consumers-manifest.json');

  // MCP manifest + skill files
  const mcpRegistry = new CapabilityRegistry();
  for (const cap of capabilities) {
    if (isMcpExposed(cap)) {
      mcpRegistry.register(cap);
    }
  }
  const mcpManifest = buildMcpManifest(mcpRegistry);
  writeFile(path.join(outputDir, 'mcp-manifest.json'), JSON.stringify(mcpManifest, null, 2));
  generated.push('mcp-manifest.json');

  for (const cap of capabilities.filter(isMcpExposed)) {
    const skillDir = path.join(outputDir, 'skills', cap.domain);
    const skillPath = path.join(skillDir, `${toKebabCase(cap.name)}.md`);
    writeFile(skillPath, renderSkillFile(cap));
    generated.push(path.join('skills', cap.domain, `${toKebabCase(cap.name)}.md`));
  }

  // Entity types
  const entityTypesContent = generateEntityTypeFile(entities);
  writeFile(path.join(outputDir, 'entity-types.ts'), entityTypesContent);
  generated.push('entity-types.ts');

  // PlumbusRegistry augmentation (.d.ts)
  const declarationContent = generatePlumbusDeclaration(capabilities, events, flows, entities);
  writeFile(path.join(outputDir, 'plumbus.d.ts'), declarationContent);
  generated.push('plumbus.d.ts');

  // In monorepo mode, also write shared types to libs/shared/types/
  if (sharedTypesDir) {
    writeFile(path.join(sharedTypesDir, 'entity-types.ts'), entityTypesContent);
    writeFile(path.join(sharedTypesDir, 'capability-types.ts'), capabilityTypeLines.join('\n\n'));
    writeFile(path.join(sharedTypesDir, 'plumbus.d.ts'), declarationContent);
  }

  return generated;
}

const GENERATED_INCLUDE_ENTRY = '.plumbus/generated';

/**
 * Ensure a tsconfig.json file includes `.plumbus/generated` in its `include` array.
 * Uses JSONC-aware editing to preserve comments in the file.
 * Returns true if the file was modified, false otherwise.
 */
export function ensureTsconfigIncludesGenerated(tsconfigPath: string): boolean {
  if (!exists(tsconfigPath)) {
    return false;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(tsconfigPath, 'utf-8');
  } catch {
    warn(`Could not read ${tsconfigPath} — add "${GENERATED_INCLUDE_ENTRY}" to include manually`);
    return false;
  }

  let tsconfig: Record<string, unknown>;
  try {
    tsconfig = JSONC.parse(raw) as Record<string, unknown>;
  } catch {
    warn(`Could not parse ${tsconfigPath} — add "${GENERATED_INCLUDE_ENTRY}" to include manually`);
    return false;
  }

  const include = tsconfig.include as string[] | undefined;
  if (!Array.isArray(include)) {
    info(
      `${tsconfigPath} has no include array — generated types should be picked up automatically`,
    );
    return false;
  }

  if (include.includes(GENERATED_INCLUDE_ENTRY)) {
    return false;
  }

  const edits = JSONC.modify(raw, ['include', -1], GENERATED_INCLUDE_ENTRY, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  const updated = JSONC.applyEdits(raw, edits);
  writeFile(tsconfigPath, updated.endsWith('\n') ? updated : `${updated}\n`);
  return true;
}

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description(
      'Generate derived artifacts from contracts (API clients, hooks, OpenAPI, manifest)',
    )
    .option('--json', 'Output results as JSON')
    .action(async (opts: GenerateOptions) => {
      const outputDir = resolvePath('.plumbus', 'generated');

      info('Scanning for registered resources...');
      let capabilities: CapabilityContract[] = [];
      let entities: EntityDefinition[] = [];
      let events: EventDefinition[] = [];
      let flows: FlowDefinition[] = [];
      try {
        const resources = await discoverResources();
        capabilities = resources.capabilities;
        entities = resources.entities;
        events = resources.events;
        flows = resources.flows;
        if (capabilities.length > 0) {
          info(`Discovered ${capabilities.length} capability(ies)`);
        } else {
          warn('No capabilities found in app/capabilities/');
        }
        if (entities.length > 0) {
          info(`Discovered ${entities.length} entity(ies)`);
        } else {
          warn('No entities found in app/entities/');
        }
        if (events.length > 0) {
          info(`Discovered ${events.length} event(s)`);
        }
        if (flows.length > 0) {
          info(`Discovered ${flows.length} flow(s)`);
        }
      } catch {
        warn('Could not auto-discover resources (app/ directory may not exist)');
      }

      const monorepo = detectMonorepoLayout();
      const generated = generateAll(
        capabilities,
        outputDir,
        entities,
        events,
        flows,
        monorepo.sharedTypesDir,
      );

      // Ensure tsconfig.json includes the generated directory
      const tsconfigPaths = monorepo.isMonorepo
        ? [resolvePath('backend', 'tsconfig.json'), resolvePath('frontend', 'tsconfig.json')]
        : [resolvePath('tsconfig.json')];

      for (const tsconfigPath of tsconfigPaths) {
        if (ensureTsconfigIncludesGenerated(tsconfigPath)) {
          success(
            `Added "${GENERATED_INCLUDE_ENTRY}" to ${path.relative(process.cwd(), tsconfigPath)}`,
          );
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ generated }, null, 2));
      } else {
        for (const f of generated) {
          success(`Generated .plumbus/generated/${f}`);
        }
      }
    });
}
