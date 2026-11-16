import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { compileFlowDefinition } from '../../flows/compile-flow.js';
import { FlowStepType } from '../../types/enums.js';
import {
  collectRetainedCompiledFlows,
  writeCompiledFlowArtifacts,
  writeRetainedCompiledFlowArtifacts,
} from '../commands/compile-flows.js';
import {
  loadCompiledFlowRegistryFromDirectory,
  RETAINED_COMPILED_FLOWS_SUBDIRECTORY,
} from '../../flows/compiled-registry.js';

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
    const artifactPath = written[0];
    assert(artifactPath);
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
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

function ping(version: string, stepName: string) {
  return compileFlowDefinition(
    defineFlow({
      name: 'ping',
      domain: 'ops',
      version,
      input: z.object({}),
      steps: [{ name: stepName, type: FlowStepType.Capability }],
    }),
  );
}

function pong(version: string) {
  return compileFlowDefinition(
    defineFlow({
      name: 'pong',
      domain: 'ops',
      version,
      input: z.object({}),
      steps: [{ name: 'noop', type: FlowStepType.Capability }],
    }),
  );
}

function tempOut(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-compile-flows-'));
  dirs.push(dir);
  return dir;
}

describe('writeCompiledFlowArtifacts replaces the previous build', () => {
  it('removes top-level definitions this build no longer ships, and leaves retained/ alone', () => {
    const outDir = tempOut();
    writeCompiledFlowArtifacts([ping('1', 'original'), pong('1')], outDir);
    writeRetainedCompiledFlowArtifacts([ping('0', 'oldest')], outDir);

    writeCompiledFlowArtifacts([ping('2', 'replacement')], outDir);

    expect(fs.readdirSync(outDir).filter((n) => n.endsWith('.json'))).toEqual(['ops.ping@2.json']);
    expect(fs.readdirSync(path.join(outDir, RETAINED_COMPILED_FLOWS_SUBDIRECTORY))).toEqual([
      'ops.ping@0.json',
    ]);
    expect(
      loadCompiledFlowRegistryFromDirectory(outDir).getCurrent('ops.ping')?.definitionVersion,
    ).toBe('2');
  });
});

describe('collectRetainedCompiledFlows', () => {
  it('keeps what earlier builds shipped and this one does not, from their top level and retained/', () => {
    const release1 = tempOut();
    writeCompiledFlowArtifacts([ping('1', 'original'), pong('1')], release1);
    const release2 = tempOut();
    writeCompiledFlowArtifacts([ping('2', 'second'), pong('1')], release2);
    writeRetainedCompiledFlowArtifacts([ping('1', 'original')], release2);

    const current = [ping('3', 'third'), pong('1')];
    const retained = collectRetainedCompiledFlows(current, [release1, release2]);
    expect(retained.map((r) => `${r.flowDefinitionId}@${r.definitionVersion}`)).toEqual([
      'ops.ping@1',
      'ops.ping@2',
    ]);

    const outDir = tempOut();
    writeCompiledFlowArtifacts(current, outDir);
    writeRetainedCompiledFlowArtifacts(retained, outDir);
    const registry = loadCompiledFlowRegistryFromDirectory(outDir);
    expect(registry.getCurrent('ops.ping')?.definitionVersion).toBe('3');
    expect(registry.isRetained('ops.ping', '1')).toBe(true);
    expect(registry.isRetained('ops.ping', '2')).toBe(true);
    expect(registry.getCurrent('ops.pong')?.definitionVersion).toBe('1');
  });

  it('refuses an earlier definition this build changed without a new version', () => {
    const release = tempOut();
    writeCompiledFlowArtifacts([ping('1', 'original')], release);
    expect(() => collectRetainedCompiledFlows([ping('1', 'changed')], [release])).toThrow(
      /changed without a new version/,
    );
  });

  it('refuses two earlier builds that disagree about one version', () => {
    const a = tempOut();
    writeCompiledFlowArtifacts([ping('1', 'original')], a);
    const b = tempOut();
    writeCompiledFlowArtifacts([ping('1', 'changed')], b);
    expect(() => collectRetainedCompiledFlows([ping('2', 'new')], [a, b])).toThrow(
      /differs between/,
    );
  });

  it('refuses a tampered earlier definition and a missing directory', () => {
    const release = tempOut();
    const [filePath] = writeCompiledFlowArtifacts([ping('1', 'original')], release);
    assert(filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    parsed.description = 'tampered';
    fs.writeFileSync(filePath, JSON.stringify(parsed));
    expect(() => collectRetainedCompiledFlows([ping('2', 'new')], [release])).toThrow(
      /digest does not match/,
    );
    expect(() =>
      collectRetainedCompiledFlows([], [path.join(os.tmpdir(), 'plumbus-retain-missing')]),
    ).toThrow(/does not exist/);
  });

  it('empties retained/ when nothing is retained', () => {
    const outDir = tempOut();
    writeRetainedCompiledFlowArtifacts([ping('1', 'original')], outDir);
    writeRetainedCompiledFlowArtifacts([], outDir);
    expect(fs.readdirSync(path.join(outDir, RETAINED_COMPILED_FLOWS_SUBDIRECTORY))).toEqual([]);
  });
});
