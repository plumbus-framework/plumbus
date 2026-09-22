export type { KnowledgeScope } from './types/scope.js';
export type { KnowledgeProvider } from './types/provider.js';
export type { SearchResult, ScoredBlock } from './types/result.js';
export type { ToolDefinition, KnowledgeToolDefinition } from './types/tool.js';
export type {
  KnowledgeSource,
  KnowledgeSourceDefinition,
  RankerFn,
} from './types/source.js';

export {
  defineKnowledgeSource,
  type KnowledgeSourceConfig,
} from './define/defineKnowledgeSource.js';
export {
  createKnowledgeRegistry,
  type KnowledgeRegistry,
} from './registry/create-knowledge-registry.js';

export { staticBlocks } from './providers/static-blocks.js';
export { translationCatalog } from './providers/translation-catalog.js';
export { capabilityBacked } from './providers/capability-backed.js';
export { documentCollection } from './providers/document-collection.js';
export { ragCorpus } from './providers/rag-corpus.js';

export { scopeSpecificityRanker, filterBlocksByScope } from './ranker/scope-specificity.js';
export { packBlocks, estimateTokens } from './ranker/pack-blocks.js';
export { scopeToRetrieveFilter } from './scope/to-retrieve-filter.js';

export { KnowledgeError, KnowledgeErrorCode } from './internal/knowledge-error.js';
