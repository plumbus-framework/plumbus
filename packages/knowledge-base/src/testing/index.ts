import type { KnowledgeScope } from '../types/scope.js';
import type { KnowledgeSource, KnowledgeSourceDefinition } from '../types/source.js';
import {
  createKnowledgeRegistry,
  type KnowledgeRegistry,
} from '../registry/create-knowledge-registry.js';

export function mockKnowledgeSource(
  text: string,
  opts?: { name?: string; scope?: KnowledgeScope },
): KnowledgeSource {
  const name = opts?.name ?? 'mock-kb';
  const definition: KnowledgeSourceDefinition = {
    name,
    provider: {
      async getBlock() {
        return text;
      },
    },
  };
  return createTestRegistry([definition]).get(name);
}

export function createTestRegistry(sources: KnowledgeSourceDefinition[]): KnowledgeRegistry {
  return createKnowledgeRegistry({ sources });
}

export function expectKnowledgeCalled(
  spy: { calls: Array<{ method: string; scope?: KnowledgeScope }> },
  expectations: { method: string; scope?: Partial<KnowledgeScope> },
): void {
  const match = spy.calls.find((call) => {
    if (call.method !== expectations.method) return false;
    if (!expectations.scope) return true;
    for (const [key, value] of Object.entries(expectations.scope)) {
      if (call.scope?.[key as keyof KnowledgeScope] !== value) return false;
    }
    return true;
  });
  if (!match) {
    throw new Error(
      `expected knowledge call ${JSON.stringify(expectations)} but got ${JSON.stringify(spy.calls)}`,
    );
  }
}
