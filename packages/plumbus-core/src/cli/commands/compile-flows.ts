// ── plumbus compile-flows ──
// Compile defineFlow modules into signed FlowDefinition JSON.

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_COMPILED_FLOWS_DIRECTORY } from '../../flows/compiled-registry.js';
import { compileFlowDefinition } from '../../flows/compile-flow.js';
import type { CompiledFlowDefinition } from '../../types/flow.js';
import { discoverResources } from '../discover.js';
import { findPlumbusProjectRoot, info, error as logError, success } from '../utils.js';

export interface CompileFlowsOptions {
  out?: string;
  json?: boolean;
}

export function writeCompiledFlowArtifacts(
  compiled: CompiledFlowDefinition[],
  outDir: string,
): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const artifact of compiled) {
    const fileName = `${artifact.flowDefinitionId}@${artifact.definitionVersion}.json`;
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
    written.push(filePath);
  }
  return written;
}

export function registerCompileFlowsCommand(program: Command): void {
  program
    .command('compile-flows')
    .description('Compile defineFlow modules into signed FlowDefinition JSON')
    .option('-o, --out <dir>', 'Output directory', DEFAULT_COMPILED_FLOWS_DIRECTORY)
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
      const written = writeCompiledFlowArtifacts(compiled, outDir);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              outDir,
              flows: compiled.map((c, i) => ({
                flowDefinitionId: c.flowDefinitionId,
                definitionVersion: c.definitionVersion,
                definitionDigest: c.definitionDigest,
                path: written[i],
              })),
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
    });
}
