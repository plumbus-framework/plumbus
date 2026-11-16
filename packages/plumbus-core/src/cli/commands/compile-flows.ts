// ── plumbus compile-flows ──
// Compile defineFlow modules into signed FlowDefinition JSON.
//
// The output directory's top level is this build's definitions and nothing else: earlier files
// there are replaced. `--retain <dir...>` keeps earlier releases' definitions in `retained/`, so
// executions pinned to them can still finish after a deploy; no new execution starts on them.

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_COMPILED_FLOWS_DIRECTORY,
  parseCompiledFlowArtifact,
  RETAINED_COMPILED_FLOWS_SUBDIRECTORY,
} from '../../flows/compiled-registry.js';
import { compileFlowDefinition } from '../../flows/compile-flow.js';
import type { CompiledFlowDefinition } from '../../types/flow.js';
import { discoverResources } from '../discover.js';
import { findPlumbusProjectRoot, info, error as logError, success } from '../utils.js';

export interface CompileFlowsOptions {
  out?: string;
  json?: boolean;
  retain?: string[];
}

function artifactFileName(artifact: CompiledFlowDefinition): string {
  return `${artifact.flowDefinitionId}@${artifact.definitionVersion}.json`;
}

function jsonFilesIn(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => fs.statSync(path.join(directory, name)).isFile())
    .sort();
}

/** Writes `artifacts` into `directory`, removing every other JSON file at its top level. */
function replaceArtifacts(artifacts: CompiledFlowDefinition[], directory: string): string[] {
  fs.mkdirSync(directory, { recursive: true });
  const keep = new Set(artifacts.map(artifactFileName));
  for (const name of jsonFilesIn(directory)) {
    if (!keep.has(name)) fs.rmSync(path.join(directory, name));
  }
  const written: string[] = [];
  for (const artifact of artifacts) {
    const filePath = path.join(directory, artifactFileName(artifact));
    fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
    written.push(filePath);
  }
  return written;
}

/**
 * Writes this build's definitions to `outDir`. Its top level then holds exactly these: a file
 * left from an earlier build (another version of a flow, a removed flow) is deleted, because
 * every top-level definition loads as its flow's current version. `retained/` is not touched.
 */
export function writeCompiledFlowArtifacts(
  compiled: CompiledFlowDefinition[],
  outDir: string,
): string[] {
  return replaceArtifacts(compiled, outDir);
}

/**
 * The definitions in earlier compiled-flows directories (each the output of an earlier build:
 * its top level and its own `retained/`) that this build does not ship, digest-checked. A
 * definition this build ships under the same id and version must be byte-identical (same
 * digest), and two sources may not disagree about one: a changed definition needs a new version.
 */
export function collectRetainedCompiledFlows(
  current: readonly CompiledFlowDefinition[],
  sources: readonly string[],
): CompiledFlowDefinition[] {
  const shipped = new Map(current.map((c) => [artifactFileName(c), c]));
  const retained = new Map<string, { artifact: CompiledFlowDefinition; source: string }>();

  for (const source of sources) {
    const root = path.resolve(source);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`Retained compiled flow directory does not exist: ${source}`);
    }
    const nested = path.join(root, RETAINED_COMPILED_FLOWS_SUBDIRECTORY);
    for (const directory of [root, nested]) {
      for (const name of jsonFilesIn(directory)) {
        const filePath = path.join(directory, name);
        const artifact = parseCompiledFlowArtifact(
          JSON.parse(fs.readFileSync(filePath, 'utf-8')),
          filePath,
        );
        const key = artifactFileName(artifact);
        const same = shipped.get(key);
        if (same) {
          if (same.definitionDigest !== artifact.definitionDigest) {
            throw new Error(
              `Flow definition "${artifact.flowDefinitionId}@${artifact.definitionVersion}" changed ` +
                `without a new version: ${filePath} differs from this build's (bump the flow's version)`,
            );
          }
          continue;
        }
        const earlier = retained.get(key);
        if (earlier) {
          if (earlier.artifact.definitionDigest !== artifact.definitionDigest) {
            throw new Error(
              `Flow definition "${artifact.flowDefinitionId}@${artifact.definitionVersion}" differs ` +
                `between ${earlier.source} and ${filePath}`,
            );
          }
          continue;
        }
        retained.set(key, { artifact, source: filePath });
      }
    }
  }
  return [...retained.values()]
    .map((entry) => entry.artifact)
    .sort((a, b) => artifactFileName(a).localeCompare(artifactFileName(b)));
}

/** Replaces `outDir/retained/` with exactly `retained` (empty: the folder is emptied). */
export function writeRetainedCompiledFlowArtifacts(
  retained: CompiledFlowDefinition[],
  outDir: string,
): string[] {
  return replaceArtifacts(retained, path.join(outDir, RETAINED_COMPILED_FLOWS_SUBDIRECTORY));
}

function describe(artifacts: CompiledFlowDefinition[], paths: string[]) {
  return artifacts.map((c, i) => ({
    flowDefinitionId: c.flowDefinitionId,
    definitionVersion: c.definitionVersion,
    definitionDigest: c.definitionDigest,
    path: paths[i],
  }));
}

export function registerCompileFlowsCommand(program: Command): void {
  program
    .command('compile-flows')
    .description('Compile defineFlow modules into signed FlowDefinition JSON')
    .option('-o, --out <dir>', 'Output directory', DEFAULT_COMPILED_FLOWS_DIRECTORY)
    .option(
      '--retain <dir...>',
      'Earlier builds’ compiled-flows directories: keep the definitions this build no longer ships in <out>/retained/',
    )
    .option('--json', 'JSON output')
    .action(async (opts: CompileFlowsOptions) => {
      const root = findPlumbusProjectRoot() ?? process.cwd();
      const resources = await discoverResources(root);
      if (resources.flows.length === 0) {
        logError('No defineFlow modules found under app/flows');
        process.exitCode = 1;
        return;
      }

      const compiled = resources.flows.map((flow) => compileFlowDefinition(flow));
      const outDir = path.resolve(root, opts.out ?? DEFAULT_COMPILED_FLOWS_DIRECTORY);
      let retained: CompiledFlowDefinition[];
      try {
        retained = collectRetainedCompiledFlows(
          compiled,
          (opts.retain ?? []).map((dir) => path.resolve(root, dir)),
        );
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const written = writeCompiledFlowArtifacts(compiled, outDir);
      const retainedWritten = writeRetainedCompiledFlowArtifacts(retained, outDir);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              outDir,
              flows: describe(compiled, written),
              retained: describe(retained, retainedWritten),
            },
            null,
            2,
          ),
        );
        return;
      }

      success(`Compiled ${compiled.length} flow(s) → ${outDir}`);
      for (const artifact of compiled) {
        info(
          `${artifact.flowDefinitionId}@${artifact.definitionVersion} digest=${artifact.definitionDigest}`,
        );
      }
      if (retained.length > 0) {
        success(
          `Retained ${retained.length} earlier definition(s) → ${path.join(outDir, RETAINED_COMPILED_FLOWS_SUBDIRECTORY)}`,
        );
        for (const artifact of retained) {
          info(
            `${artifact.flowDefinitionId}@${artifact.definitionVersion} digest=${artifact.definitionDigest}`,
          );
        }
      }
    });
}
