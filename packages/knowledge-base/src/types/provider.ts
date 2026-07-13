import type { ExecutionContext } from '@plumbus/core';
import type { SearchResult } from './result.js';
import type { KnowledgeScope } from './scope.js';
import type { ToolDefinition } from './tool.js';
import type { RankerFn } from './source.js';

export interface KnowledgeProvider {
  getBlock(
    ctx: ExecutionContext,
    scope: KnowledgeScope,
    opts?: { maxTokens?: number; query?: string; ranker?: RankerFn },
  ): Promise<string>;

  getTools?(ctx: ExecutionContext, scope: KnowledgeScope): Promise<ToolDefinition[]>;

  search?(
    ctx: ExecutionContext,
    query: string,
    scope: KnowledgeScope,
    opts?: { topK?: number },
  ): Promise<SearchResult[]>;
}
