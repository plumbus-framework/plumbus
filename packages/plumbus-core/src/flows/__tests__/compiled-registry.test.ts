import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { FlowStepType } from '../../types/enums.js';
import { compileFlowDefinition } from '../compile-flow.js';
import {
  CompiledFlowRegistry,
  DEFAULT_COMPILED_FLOWS_DIRECTORY,
  RETAINED_COMPILED_FLOWS_SUBDIRECTORY,
  loadCompiledFlowRegistryFromDirectory,
  parseCompiledFlowArtifact,
  resolveCompiledFlowRegistry,
  tryLoadCompiledFlowRegistryFromDirectory,
} from '../compiled-registry.js';

function ping(version: string, stepName: string) {
  return defineFlow({
    name: 'ping',
    domain: 'ops',
    version,
    input: z.object({}),
    steps: [{ name: stepName, type: FlowStepType.Capability }],
  });
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-compiled-registry-'));
  dirs.push(dir);
  return dir;
}

function writeArtifact(dir: string, compiled: ReturnType<typeof compileFlowDefinition>): string {
  const fileName = `${compiled.flowDefinitionId}@${compiled.definitionVersion}.json`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(compiled, null, 2)}\n`, 'utf-8');
  return filePath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CompiledFlowRegistry', () => {
  it('retains every published version and resolves by (id, version)', () => {
    const registry = new CompiledFlowRegistry();
    const v1 = compileFlowDefinition(ping('1', 'original'));
    const v2 = compileFlowDefinition(ping('2', 'replacement'));
    registry.publish(v1);
    registry.publish(v2);

    expect(registry.get('ops.ping', '1')?.definitionDigest).toBe(v1.definitionDigest);
    expect(registry.get('ops.ping', '2')?.definitionDigest).toBe(v2.definitionDigest);
    expect(registry.getLatest('ops.ping')?.definitionVersion).toBe('2');
    expect(registry.listVersions('ops.ping')).toEqual(['1', '2']);
  });

  it('treats republish of the same version and digest as idempotent', () => {
    const registry = new CompiledFlowRegistry();
    const compiled = compileFlowDefinition(ping('1', 'original'));
    registry.publish(compiled);
    registry.publish(compileFlowDefinition(ping('1', 'original')));
    expect(registry.listVersions('ops.ping')).toEqual(['1']);
  });

  it('rejects a same-version publish with a different digest', () => {
    const registry = new CompiledFlowRegistry();
    registry.publish(compileFlowDefinition(ping('1', 'original')));
    expect(() => registry.publish(compileFlowDefinition(ping('1', 'replacement')))).toThrow(
      /immutable/,
    );
  });

  it('starts new executions on the current version, never on a retained one', () => {
    const registry = new CompiledFlowRegistry();
    const v2 = compileFlowDefinition(ping('2', 'replacement'));
    const v1 = compileFlowDefinition(ping('1', 'original'));
    registry.publish(v2);
    registry.publish(v1, { retained: true });

    expect(registry.getCurrent('ops.ping')?.definitionVersion).toBe('2');
    expect(registry.getLatest('ops.ping')?.definitionVersion).toBe('2');
    expect(registry.get('ops.ping', '1')?.definitionDigest).toBe(v1.definitionDigest);
    expect(registry.isRetained('ops.ping', '1')).toBe(true);
    expect(registry.isRetained('ops.ping', '2')).toBe(false);
    expect(registry.listVersions('ops.ping')).toEqual(['2', '1']);
  });

  it('has no current version when every version is retained', () => {
    const registry = new CompiledFlowRegistry();
    registry.publish(compileFlowDefinition(ping('1', 'original')), { retained: true });
    expect(registry.getCurrent('ops.ping')).toBeUndefined();
    expect(registry.get('ops.ping', '1')).toBeDefined();
  });

  it('makes a retained version current when it is published as current', () => {
    const registry = new CompiledFlowRegistry();
    registry.publish(compileFlowDefinition(ping('1', 'original')), { retained: true });
    registry.publish(compileFlowDefinition(ping('1', 'original')));
    expect(registry.getCurrent('ops.ping')?.definitionVersion).toBe('1');
    expect(registry.isRetained('ops.ping', '1')).toBe(false);
  });

  it('keeps a current version current when the same version is retained too', () => {
    const registry = new CompiledFlowRegistry();
    registry.publish(compileFlowDefinition(ping('1', 'original')));
    registry.publish(compileFlowDefinition(ping('1', 'original')), { retained: true });
    expect(registry.getCurrent('ops.ping')?.definitionVersion).toBe('1');
    expect(registry.isRetained('ops.ping', '1')).toBe(false);
  });

  it('rejects a retained definition that differs from the current one under the same version', () => {
    const registry = new CompiledFlowRegistry();
    registry.publish(compileFlowDefinition(ping('1', 'original')));
    expect(() =>
      registry.publish(compileFlowDefinition(ping('1', 'replacement')), { retained: true }),
    ).toThrow(/immutable/);
  });
});

describe('loadCompiledFlowRegistryFromDirectory', () => {
  it('reloads published artifacts after a new registry is opened on the same directory', () => {
    const compiled = compileFlowDefinition(ping('1', 'original'));
    const directory = tempDir();
    writeArtifact(directory, compiled);

    const first = loadCompiledFlowRegistryFromDirectory(directory);
    expect(first.get('ops.ping', '1')?.definitionDigest).toBe(compiled.definitionDigest);

    const reloaded = loadCompiledFlowRegistryFromDirectory(directory);
    expect(reloaded.get('ops.ping', '1')?.definitionDigest).toBe(compiled.definitionDigest);
    expect(reloaded.getLatest('ops.ping')?.definitionVersion).toBe('1');
  });

  it('refuses a tampered body whose stored digest no longer matches', () => {
    const compiled = compileFlowDefinition(ping('1', 'original'));
    const directory = tempDir();
    const filePath = writeArtifact(directory, compiled);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    parsed.description = 'tampered';
    fs.writeFileSync(filePath, `${JSON.stringify(parsed)}\n`, 'utf-8');

    expect(() => loadCompiledFlowRegistryFromDirectory(directory)).toThrow(/digest does not match/);
    try {
      loadCompiledFlowRegistryFromDirectory(directory);
    } catch (err) {
      expect(String(err)).not.toContain('tampered');
      expect(String(err)).not.toContain(compiled.steps[0]?.name);
    }
  });

  it('ignores non-JSON files and throws on invalid JSON', () => {
    const compiled = compileFlowDefinition(ping('1', 'original'));
    const directory = tempDir();
    writeArtifact(directory, compiled);
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'not a flow');
    fs.writeFileSync(path.join(directory, 'broken.json'), '{');

    expect(() => loadCompiledFlowRegistryFromDirectory(directory)).toThrow(/not valid JSON/);
  });

  it('loads retained/ as retained: the top level stays current whatever the file names', () => {
    // 1.10.0 sorts before 1.9.0 by name: under "last loaded wins" the old version would start runs.
    const directory = tempDir();
    const retainedDir = path.join(directory, RETAINED_COMPILED_FLOWS_SUBDIRECTORY);
    fs.mkdirSync(retainedDir);
    const current = compileFlowDefinition(ping('1.10.0', 'replacement'));
    const earlier = compileFlowDefinition(ping('1.9.0', 'original'));
    writeArtifact(directory, current);
    writeArtifact(retainedDir, earlier);

    const registry = loadCompiledFlowRegistryFromDirectory(directory);
    expect(registry.getCurrent('ops.ping')?.definitionVersion).toBe('1.10.0');
    expect(registry.get('ops.ping', '1.9.0')?.definitionDigest).toBe(earlier.definitionDigest);
    expect(registry.isRetained('ops.ping', '1.9.0')).toBe(true);
  });

  it('refuses two current versions of one flow at the top level', () => {
    const directory = tempDir();
    writeArtifact(directory, compileFlowDefinition(ping('1.9.0', 'original')));
    writeArtifact(directory, compileFlowDefinition(ping('1.10.0', 'replacement')));
    expect(() => loadCompiledFlowRegistryFromDirectory(directory)).toThrow(
      /more than one current version of "ops.ping" \(1\.10\.0, 1\.9\.0\)/,
    );
  });

  it('refuses a retained file that changed a current version without a new version', () => {
    const directory = tempDir();
    const retainedDir = path.join(directory, RETAINED_COMPILED_FLOWS_SUBDIRECTORY);
    fs.mkdirSync(retainedDir);
    writeArtifact(directory, compileFlowDefinition(ping('1', 'replacement')));
    writeArtifact(retainedDir, compileFlowDefinition(ping('1', 'original')));
    expect(() => loadCompiledFlowRegistryFromDirectory(directory)).toThrow(/immutable/);
  });

  it('digest-checks retained files like current ones', () => {
    const directory = tempDir();
    const retainedDir = path.join(directory, RETAINED_COMPILED_FLOWS_SUBDIRECTORY);
    fs.mkdirSync(retainedDir);
    writeArtifact(directory, compileFlowDefinition(ping('2', 'replacement')));
    const filePath = writeArtifact(retainedDir, compileFlowDefinition(ping('1', 'original')));
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    parsed.description = 'tampered';
    fs.writeFileSync(filePath, `${JSON.stringify(parsed)}\n`, 'utf-8');
    expect(() => loadCompiledFlowRegistryFromDirectory(directory)).toThrow(/digest does not match/);
  });

  it('throws when the directory is missing', () => {
    expect(() =>
      loadCompiledFlowRegistryFromDirectory(path.join(os.tmpdir(), 'plumbus-compiled-missing')),
    ).toThrow(/does not exist/);
  });
});

describe('tryLoadCompiledFlowRegistryFromDirectory', () => {
  it('returns undefined for a missing or empty directory', () => {
    expect(
      tryLoadCompiledFlowRegistryFromDirectory(path.join(os.tmpdir(), 'plumbus-compiled-missing')),
    ).toBeUndefined();
    expect(tryLoadCompiledFlowRegistryFromDirectory(tempDir())).toBeUndefined();
  });

  it('loads when JSON artifacts are present', () => {
    const compiled = compileFlowDefinition(ping('2', 'next'));
    const directory = tempDir();
    writeArtifact(directory, compiled);
    const loaded = tryLoadCompiledFlowRegistryFromDirectory(directory);
    expect(loaded?.get('ops.ping', '2')?.definitionDigest).toBe(compiled.definitionDigest);
  });
});

describe('resolveCompiledFlowRegistry', () => {
  it('prefers an explicit registry over a directory', () => {
    const compiled = compileFlowDefinition(ping('1', 'original'));
    const directory = tempDir();
    writeArtifact(directory, compileFlowDefinition(ping('2', 'other')));
    const explicit = new CompiledFlowRegistry();
    explicit.publish(compiled);

    const resolved = resolveCompiledFlowRegistry({
      compiledRegistry: explicit,
      compiledFlowsDirectory: directory,
    });
    expect(resolved).toBe(explicit);
    expect(resolved?.listVersions('ops.ping')).toEqual(['1']);
  });

  it('fails closed when an explicit directory has no artifacts', () => {
    expect(() => resolveCompiledFlowRegistry({ compiledFlowsDirectory: tempDir() })).toThrow(
      /no artifacts/,
    );
  });

  it('loads the default compiled-flows tree from cwd when it has JSON', () => {
    const cwd = tempDir();
    const compiledDir = path.join(cwd, DEFAULT_COMPILED_FLOWS_DIRECTORY);
    fs.mkdirSync(compiledDir, { recursive: true });
    const compiled = compileFlowDefinition(ping('1', 'original'));
    writeArtifact(compiledDir, compiled);

    const resolved = resolveCompiledFlowRegistry({ cwd });
    expect(resolved?.get('ops.ping', '1')?.definitionDigest).toBe(compiled.definitionDigest);
  });

  it('leaves live TypeScript mode on when the default tree is absent', () => {
    expect(resolveCompiledFlowRegistry({ cwd: tempDir() })).toBeUndefined();
  });
});

describe('parseCompiledFlowArtifact', () => {
  it('accepts a freshly compiled object', () => {
    const compiled = compileFlowDefinition(ping('1', 'original'));
    expect(parseCompiledFlowArtifact(compiled).definitionDigest).toBe(compiled.definitionDigest);
  });
});
