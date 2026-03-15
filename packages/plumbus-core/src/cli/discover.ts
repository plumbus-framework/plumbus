// ── Resource Auto-Discovery ──
// Scans app/ directories for defineCapability, defineEntity, defineFlow,
// defineEvent, definePrompt exports and returns them.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilityContract } from '../types/capability.js';
import type { EntityDefinition } from '../types/entity.js';
import type { EventDefinition } from '../types/event.js';
import type { FlowDefinition } from '../types/flow.js';
import type { PromptDefinition } from '../types/prompt.js';

export interface DiscoveredResources {
  capabilities: CapabilityContract[];
  entities: EntityDefinition[];
  flows: FlowDefinition[];
  events: EventDefinition[];
  prompts: PromptDefinition[];
}

/**
 * Scan a directory for .ts/.js files and dynamically import all exports.
 * Returns an array of all exported values.
 */
async function scanDir(dir: string): Promise<unknown[]> {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir, { recursive: true })
    .map((f) => String(f))
    .filter(
      (f) =>
        (f.endsWith('.ts') || f.endsWith('.js')) &&
        !f.endsWith('.d.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.js'),
    );

  const exports: unknown[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const fileUrl = pathToFileURL(filePath).href;
    try {
      const mod = (await import(fileUrl)) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        exports.push(value);
      }
    } catch {
      // Skip files that fail to import
    }
  }
  return exports;
}

function isCapability(v: unknown): v is CapabilityContract {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    'kind' in v &&
    'domain' in v &&
    'handler' in v &&
    'effects' in v
  );
}

function isEntity(v: unknown): v is EntityDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    'fields' in v &&
    !('kind' in v) &&
    !('handler' in v) &&
    !('steps' in v) &&
    !('payload' in v) &&
    !('input' in v)
  );
}

function isFlow(v: unknown): v is FlowDefinition {
  return typeof v === 'object' && v !== null && 'name' in v && 'steps' in v && 'domain' in v;
}

function isEvent(v: unknown): v is EventDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    'payload' in v &&
    !('input' in v) &&
    !('handler' in v)
  );
}

function isPrompt(v: unknown): v is PromptDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    'input' in v &&
    'output' in v &&
    !('handler' in v) &&
    !('effects' in v)
  );
}

/**
 * Discover all Plumbus resources from the app/ directory.
 * Scans each subdirectory (capabilities, entities, flows, events, prompts)
 * and classifies exported values by type.
 *
 * @param appRoot - Path to the project root (default: process.cwd())
 */
export async function discoverResources(
  appRoot: string = process.cwd(),
): Promise<DiscoveredResources> {
  const appDir = path.join(appRoot, 'app');

  // Register tsx to allow importing TypeScript files from consumer projects.
  // Use createRequire to resolve tsx from the framework's own node_modules,
  // since it may not be installed in the consumer project.
  let unregister: (() => void) | undefined;
  try {
    const require = createRequire(import.meta.url);
    const tsxPath = require.resolve('tsx/esm/api');
    const tsx = await import(pathToFileURL(tsxPath).href);
    unregister = tsx.register();
  } catch {
    // tsx not available; only .js files will be importable
  }

  try {
    const [capExports, entityExports, flowExports, eventExports, promptExports] = await Promise.all(
      [
        scanDir(path.join(appDir, 'capabilities')),
        scanDir(path.join(appDir, 'entities')),
        scanDir(path.join(appDir, 'flows')),
        scanDir(path.join(appDir, 'events')),
        scanDir(path.join(appDir, 'prompts')),
      ],
    );

    return {
      capabilities: capExports.filter(isCapability),
      entities: entityExports.filter(isEntity),
      flows: flowExports.filter(isFlow),
      events: eventExports.filter(isEvent),
      prompts: promptExports.filter(isPrompt),
    };
  } finally {
    unregister?.();
  }
}

/**
 * Synchronous check: does the app/ directory exist?
 * Useful for quick validation before attempting discovery.
 */
export function hasAppDirectory(appRoot: string = process.cwd()): boolean {
  return fs.existsSync(path.join(appRoot, 'app'));
}
