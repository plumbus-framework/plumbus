import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { FlowStepType } from '../../types/enums.js';
import { compileFlowDefinition } from '../compile-flow.js';
import { CompiledFlowRegistry } from '../compiled-registry.js';

function ping(version: string, stepName: string) {
  return defineFlow({
    name: 'ping',
    domain: 'ops',
    version,
    input: z.object({}),
    steps: [{ name: stepName, type: FlowStepType.Capability }],
  });
}

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
});
