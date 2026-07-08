import type { ExecutionContext } from '@plumbus/core';
import type { KnowledgeProvider } from '../types/provider.js';
import type { KnowledgeScope } from '../types/scope.js';
import type { KnowledgeSource, KnowledgeSourceDefinition } from '../types/source.js';
import { deepFreeze } from '../internal/deep-freeze.js';
import { KnowledgeError, KnowledgeErrorCode } from '../internal/knowledge-error.js';

export interface KnowledgeRegistry {
  get(name: string): KnowledgeSource;
  has(name: string): boolean;
  list(): KnowledgeSourceDefinition[];
}

export function createKnowledgeRegistry(opts: {
  sources: KnowledgeSourceDefinition[];
}): KnowledgeRegistry {
  const byName = new Map<string, KnowledgeSourceDefinition>();
  for (const source of opts.sources) {
    if (byName.has(source.name)) {
      throw new KnowledgeError(
        KnowledgeErrorCode.duplicateSource,
        `duplicate knowledge source name "${source.name}"`,
      );
    }
    byName.set(source.name, source);
  }

  const sources = deepFreeze([...opts.sources]);

  function wrapProvider(provider: KnowledgeProvider): KnowledgeProvider {
    const getTools = provider.getTools;
    const search = provider.search;
    return {
      getBlock: (ctx, scope, opts) => provider.getBlock(ctx, scope, opts),
      getTools: getTools ? (ctx, scope) => getTools(ctx, scope) : undefined,
      search: search ? (ctx, query, scope, opts) => search(ctx, query, scope, opts) : undefined,
    };
  }

  function toRuntimeSource(def: KnowledgeSourceDefinition): KnowledgeSource {
    const provider = wrapProvider(def.provider);
    return {
      name: def.name,
      definition: def,
      getBlock(ctx: ExecutionContext, scope: KnowledgeScope, opts) {
        return provider.getBlock(ctx, scope, {
          ...opts,
          ranker: opts?.ranker ?? def.ranker,
        });
      },
      async getTools(ctx: ExecutionContext, scope: KnowledgeScope) {
        if (!provider.getTools) {
          throw tierError(def.name, 'getTools');
        }
        return provider.getTools(ctx, scope);
      },
      async search(
        ctx: ExecutionContext,
        query: string,
        scope: KnowledgeScope,
        opts?: { topK?: number },
      ) {
        if (!provider.search) {
          throw tierError(def.name, 'search');
        }
        return provider.search(ctx, query, scope, opts);
      },
    };
  }

  const runtimeByName = new Map<string, KnowledgeSource>();
  for (const def of sources) {
    runtimeByName.set(def.name, toRuntimeSource(def));
  }

  return deepFreeze({
    get(name: string): KnowledgeSource {
      const source = runtimeByName.get(name);
      if (!source) {
        throw new KnowledgeError(
          KnowledgeErrorCode.sourceNotFound,
          `knowledge source "${name}" not found`,
        );
      }
      return source;
    },
    has(name: string): boolean {
      return runtimeByName.has(name);
    },
    list(): KnowledgeSourceDefinition[] {
      return sources;
    },
  });
}

function tierError(sourceName: string, tier: string): KnowledgeError {
  return new KnowledgeError(
    KnowledgeErrorCode.tierNotSupported,
    `source "${sourceName}" does not implement ${tier}`,
  );
}
