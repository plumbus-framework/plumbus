import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { compileFlowDefinition } from '../../flows/compile-flow.js';
import { FlowStepType } from '../../types/enums.js';
import { writeCompiledFlowArtifacts } from '../commands/compile-flows.js';
import { loadCompiledFlowRegistryFromDirectory } from '../../flows/compiled-registry.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeCompiledFlowArtifacts', () => {
  it('writes signed JSON named by id@version', () => {
    const compiled = compileFlowDefinition(
      defineFlow({
        name: 'ping',
        domain: 'ops',
        input: z.object({}),
        steps: [{ name: 'noop', type: FlowStepType.Capability }],
      }),
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-compile-flows-'));
    dirs.push(outDir);
    const written = writeCompiledFlowArtifacts([compiled], outDir);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(fs.readFileSync(written[0]!, 'utf-8'));
    expect(parsed.flowDefinitionId).toBe('ops.ping');
    expect(parsed.definitionDigest).toBe(compiled.definitionDigest);
    expect(parsed.steps[0]).not.toHaveProperty('if');
  });

  it('reloads into CompiledFlowRegistry with the same digest', () => {
    const compiled = compileFlowDefinition(
      defineFlow({
        name: 'ping',
        domain: 'ops',
        input: z.object({}),
        steps: [{ name: 'noop', type: FlowStepType.Capability }],
      }),
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-compile-flows-'));
    dirs.push(outDir);
    writeCompiledFlowArtifacts([compiled], outDir);
    const registry = loadCompiledFlowRegistryFromDirectory(outDir);
    expect(registry.get('ops.ping', compiled.definitionVersion)?.definitionDigest).toBe(
      compiled.definitionDigest,
    );
  });
});
