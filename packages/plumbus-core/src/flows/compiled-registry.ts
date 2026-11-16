// Immutable, versioned registry of compiled flow definitions.
// Keyed by (flowDefinitionId, definitionVersion). Publishing a version
// a second time is idempotent only when the digest matches.
// Disk artifacts from `plumbus compile-flows` reload through
// loadCompiledFlowRegistryFromDirectory so a new process sees the same pins.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPILED_FLOW_CONTRACT_VERSION, digestCanonicalJson } from './compile-flow.js';
import type { CompiledFlowDefinition } from '../types/flow.js';

/** Project-relative default used by `plumbus compile-flows` and boot load. */
export const DEFAULT_COMPILED_FLOWS_DIRECTORY = '.plumbus/compiled-flows';

/**
 * Subdirectory of a compiled-flows directory holding definitions earlier releases shipped
 * (`plumbus compile-flows --retain`). They load as retained: an execution pinned to one can
 * finish on it, but no new execution starts on it.
 */
export const RETAINED_COMPILED_FLOWS_SUBDIRECTORY = 'retained';

export interface PublishCompiledFlowOptions {
  /**
   * Kept only so executions pinned to this version can finish; never the version a new
   * execution starts on. Default false: the definition is (or becomes) the flow's current one.
   */
  retained?: boolean;
}

export class CompiledFlowRegistry {
  private readonly versions = new Map<string, Map<string, CompiledFlowDefinition>>();
  /** Versions published as current, oldest first; the last one is the flow's current version. */
  private readonly currentOrder = new Map<string, string[]>();

  /**
   * Publish a compiled definition. Same version + same digest is a no-op, except that a
   * retained version published again as current becomes current. Same version + different
   * digest is rejected (immutable retain-all).
   */
  publish(compiled: CompiledFlowDefinition, options: PublishCompiledFlowOptions = {}): void {
    const { flowDefinitionId, definitionVersion, definitionDigest } = compiled;
    if (!flowDefinitionId || !definitionVersion || !definitionDigest) {
      throw new Error('Compiled flow definition is missing identity fields');
    }

    let byVersion = this.versions.get(flowDefinitionId);
    if (!byVersion) {
      byVersion = new Map();
      this.versions.set(flowDefinitionId, byVersion);
    }

    const existing = byVersion.get(definitionVersion);
    if (existing) {
      if (existing.definitionDigest !== definitionDigest) {
        throw new Error(
          `Flow definition "${flowDefinitionId}@${definitionVersion}" is immutable (digest mismatch)`,
        );
      }
      if (!options.retained) this.markCurrent(flowDefinitionId, definitionVersion);
      return;
    }

    byVersion.set(definitionVersion, compiled);
    if (!options.retained) this.markCurrent(flowDefinitionId, definitionVersion);
  }

  /** Appends a version not yet published as current; a repeat leaves the order as it was. */
  private markCurrent(flowDefinitionId: string, definitionVersion: string): void {
    const order = this.currentOrder.get(flowDefinitionId) ?? [];
    if (order.includes(definitionVersion)) return;
    order.push(definitionVersion);
    this.currentOrder.set(flowDefinitionId, order);
  }

  get(flowDefinitionId: string, definitionVersion: string): CompiledFlowDefinition | undefined {
    return this.versions.get(flowDefinitionId)?.get(definitionVersion);
  }

  /**
   * The version a new execution of this flow starts on: the one most recently published as
   * current. Retained versions are never current. Undefined when the flow has none.
   */
  getCurrent(flowDefinitionId: string): CompiledFlowDefinition | undefined {
    const current = this.currentOrder.get(flowDefinitionId)?.at(-1);
    return current === undefined ? undefined : this.get(flowDefinitionId, current);
  }

  /** @deprecated Use `getCurrent`: the same version (retained definitions are never returned). */
  getLatest(flowDefinitionId: string): CompiledFlowDefinition | undefined {
    return this.getCurrent(flowDefinitionId);
  }

  /** True when this version is held only for executions pinned to it. */
  isRetained(flowDefinitionId: string, definitionVersion: string): boolean {
    if (!this.get(flowDefinitionId, definitionVersion)) return false;
    return !(this.currentOrder.get(flowDefinitionId) ?? []).includes(definitionVersion);
  }

  /** Every version this registry can run for the flow, current and retained, in publish order. */
  listVersions(flowDefinitionId: string): string[] {
    return [...(this.versions.get(flowDefinitionId)?.keys() ?? [])];
  }
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(filePath: string, fileName: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Compiled flow artifact is not valid JSON: ${fileName}`);
    }
    throw err;
  }
}

/**
 * Parse one signed artifact. Recomputes `definitionDigest` and refuses a
 * mismatch so a tampered file cannot enter the registry.
 */
export function parseCompiledFlowArtifact(
  value: unknown,
  fileName = 'compiled-flow.json',
): CompiledFlowDefinition {
  if (!isRecord(value)) {
    throw new Error(`Compiled flow artifact is missing identity fields: ${fileName}`);
  }

  const {
    contractVersion,
    flowDefinitionId,
    definitionVersion,
    definitionDigest,
    domain,
    name,
    steps,
    bindings,
  } = value;

  if (contractVersion !== COMPILED_FLOW_CONTRACT_VERSION) {
    throw new Error(`Compiled flow artifact contract version is not supported: ${fileName}`);
  }
  if (
    typeof flowDefinitionId !== 'string' ||
    !flowDefinitionId ||
    typeof definitionVersion !== 'string' ||
    !definitionVersion ||
    typeof definitionDigest !== 'string' ||
    !definitionDigest ||
    typeof domain !== 'string' ||
    !domain ||
    typeof name !== 'string' ||
    !name ||
    !Array.isArray(steps) ||
    !Array.isArray(bindings)
  ) {
    throw new Error(`Compiled flow artifact is missing identity fields: ${fileName}`);
  }

  const { definitionDigest: storedDigest, ...unsigned } = value;
  const computed = digestCanonicalJson(unsigned);
  if (typeof storedDigest !== 'string' || computed !== storedDigest) {
    throw new Error(
      `Compiled flow artifact digest does not match: ${flowDefinitionId}@${definitionVersion}`,
    );
  }

  return value as unknown as CompiledFlowDefinition;
}

function listCompiledFlowJsonFiles(directory: string): string[] {
  const root = resolve(directory);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      throw new Error(`Compiled flow directory does not exist: ${directory}`);
    }
    if (errorCode(err) === 'ENOTDIR') {
      throw new Error(`Compiled flow path is not a directory: ${directory}`);
    }
    throw err;
  }

  return names
    .filter((name) => name.endsWith('.json'))
    .filter((name) => {
      try {
        return statSync(join(root, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Load signed JSON from a host-owned directory (the `plumbus compile-flows`
 * output). Each file is digest-checked; a mismatch refuses the whole load.
 *
 * The top-level files are this build's definitions: each is its flow's current version, and
 * two versions of one flow there are refused (which would be current depended on file names).
 * Files under `retained/` (RETAINED_COMPILED_FLOWS_SUBDIRECTORY) are earlier releases'
 * definitions, loaded for the executions pinned to them only.
 */
export function loadCompiledFlowRegistryFromDirectory(directory: string): CompiledFlowRegistry {
  const trimmed = directory.trim();
  if (!trimmed) {
    throw new Error('Compiled flow directory is required');
  }

  const root = resolve(trimmed);
  const current = listCompiledFlowJsonFiles(root).map((fileName) =>
    parseCompiledFlowArtifact(readJsonFile(join(root, fileName), fileName), fileName),
  );

  const currentVersions = new Map<string, string[]>();
  for (const compiled of current) {
    const versions = currentVersions.get(compiled.flowDefinitionId) ?? [];
    versions.push(compiled.definitionVersion);
    currentVersions.set(compiled.flowDefinitionId, versions);
  }
  for (const [flowDefinitionId, versions] of currentVersions) {
    if (versions.length > 1) {
      throw new Error(
        `Compiled flow directory has more than one current version of "${flowDefinitionId}" ` +
          `(${versions.join(', ')}): a build compiles one version per flow, and earlier ` +
          `releases' versions belong in its ${RETAINED_COMPILED_FLOWS_SUBDIRECTORY}/ folder (${directory})`,
      );
    }
  }

  const registry = new CompiledFlowRegistry();
  for (const compiled of current) registry.publish(compiled);

  const retainedRoot = join(root, RETAINED_COMPILED_FLOWS_SUBDIRECTORY);
  if (isDirectory(retainedRoot)) {
    for (const fileName of listCompiledFlowJsonFiles(retainedRoot)) {
      const parsed = readJsonFile(join(retainedRoot, fileName), fileName);
      registry.publish(parseCompiledFlowArtifact(parsed, fileName), { retained: true });
    }
  }
  return registry;
}

/**
 * Same as `loadCompiledFlowRegistryFromDirectory`, but a missing or empty
 * directory is "not configured" (`undefined`) so live TypeScript flows stay
 * on. A directory that exists with invalid JSON still throws.
 */
export function tryLoadCompiledFlowRegistryFromDirectory(
  directory: string,
): CompiledFlowRegistry | undefined {
  const trimmed = directory.trim();
  if (!trimmed) return undefined;

  const root = resolve(trimmed);
  if (!existsSync(root)) return undefined;
  try {
    if (!statSync(root).isDirectory()) {
      throw new Error(`Compiled flow path is not a directory: ${directory}`);
    }
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }

  const fileNames = listCompiledFlowJsonFiles(root);
  if (fileNames.length === 0) return undefined;
  return loadCompiledFlowRegistryFromDirectory(root);
}

export interface ResolveCompiledFlowRegistryOptions {
  compiledRegistry?: CompiledFlowRegistry;
  compiledFlowsDirectory?: string;
  cwd?: string;
}

/**
 * Prefer an explicit registry. Else load `compiledFlowsDirectory` (required
 * when set). Else try `{cwd}/.plumbus/compiled-flows` when that tree has JSON.
 */
export function resolveCompiledFlowRegistry(
  options: ResolveCompiledFlowRegistryOptions = {},
): CompiledFlowRegistry | undefined {
  if (options.compiledRegistry) return options.compiledRegistry;

  if (options.compiledFlowsDirectory !== undefined) {
    const directory = options.compiledFlowsDirectory.trim();
    if (!directory) {
      throw new Error('Compiled flow directory is required');
    }
    const fileNames = listCompiledFlowJsonFiles(resolve(directory));
    if (fileNames.length === 0) {
      throw new Error(`Compiled flow directory has no artifacts: ${directory}`);
    }
    return loadCompiledFlowRegistryFromDirectory(directory);
  }

  const cwd = options.cwd ?? process.cwd();
  return tryLoadCompiledFlowRegistryFromDirectory(join(cwd, DEFAULT_COMPILED_FLOWS_DIRECTORY));
}
