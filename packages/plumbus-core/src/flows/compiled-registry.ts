// Immutable, versioned registry of compiled flow definitions (D-02-2).
// Keyed by (flowDefinitionId, definitionVersion). Publishing a version
// a second time is idempotent only when the digest matches.

import type { CompiledFlowDefinition } from '../types/flow.js';

export class CompiledFlowRegistry {
  private readonly versions = new Map<string, Map<string, CompiledFlowDefinition>>();
  private readonly publishOrder = new Map<string, string[]>();

  /**
   * Publish a compiled definition. Same version + same digest is a no-op.
   * Same version + different digest is rejected (immutable retain-all).
   */
  publish(compiled: CompiledFlowDefinition): void {
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
      return;
    }

    byVersion.set(definitionVersion, compiled);
    const order = this.publishOrder.get(flowDefinitionId) ?? [];
    order.push(definitionVersion);
    this.publishOrder.set(flowDefinitionId, order);
  }

  get(flowDefinitionId: string, definitionVersion: string): CompiledFlowDefinition | undefined {
    return this.versions.get(flowDefinitionId)?.get(definitionVersion);
  }

  /** Most recently published version for this id (not semver-max). */
  getLatest(flowDefinitionId: string): CompiledFlowDefinition | undefined {
    const order = this.publishOrder.get(flowDefinitionId);
    if (!order?.length) return undefined;
    return this.get(flowDefinitionId, order[order.length - 1]!);
  }

  listVersions(flowDefinitionId: string): string[] {
    return [...(this.publishOrder.get(flowDefinitionId) ?? [])];
  }
}
