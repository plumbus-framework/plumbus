import type { KnowledgeProvider } from './provider.js';
import type { ScoredBlock } from './result.js';
import type { KnowledgeScope } from './scope.js';
import type { ToolDefinition } from './tool.js';

export type RankerFn = (blocks: ScoredBlock[], scope: KnowledgeScope) => ScoredBlock[];

export interface KnowledgeSourceDefinition {
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly provider: KnowledgeProvider;
  readonly ranker?: RankerFn;
}

export interface KnowledgeSource {
  readonly name: string;
  readonly definition: KnowledgeSourceDefinition;
  getBlock(
    ctx: import('@plumbus/core').ExecutionContext,
    scope: KnowledgeScope,
    opts?: { maxTokens?: number; query?: string },
  ): Promise<string>;
  getTools(
    ctx: import('@plumbus/core').ExecutionContext,
    scope: KnowledgeScope,
  ): Promise<ToolDefinition[]>;
  search(
    ctx: import('@plumbus/core').ExecutionContext,
    query: string,
    scope: KnowledgeScope,
    opts?: { topK?: number },
  ): Promise<import('./result.js').SearchResult[]>;
}
