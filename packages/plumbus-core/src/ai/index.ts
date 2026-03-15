// ── AI Module ──
// AI runtime: provider adapters (OpenAI, Anthropic), prompt registry, output
// validation, cost tracking, security scanning, explainability, and RAG pipeline.
// Used by ctx.ai in capability handlers.
//
// Key exports: createAIService, createRAGPipeline, PromptRegistry, checkPromptSecurity

// AI Service
export { createAIService, singleProviderConfig, type AIServiceConfig } from './ai-service.js';
// Cost tracking
export {
  createCostTracker,
  type AICostRecord,
  type BudgetCheckResult,
  type BudgetConfig,
  type CostTracker,
  type DailyUsage,
  type UsageSyncResult,
} from './cost-tracker.js';
// Explainability
export {
  createExplainabilityTracker,
  type AIExplainabilityTracker,
  type AIInvocationRecord,
  type ExplainabilityConfig,
} from './explainability.js';
// Prompt registry
export { PromptRegistry } from './prompt-registry.js';
// Provider adapters
export {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createProviderAdapter,
  type AIProviderAdapter,
  type AnthropicAdapterConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type OpenAIAdapterConfig,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamEvent,
  type TokenUsage,
} from './provider.js';
// RAG pipeline
export {
  chunkDocument,
  createInMemoryVectorStore,
  createRAGPipeline,
  documentChunksTable,
  documentsTable,
  type ChunkConfig,
  type DocumentChunk,
  type IngestDocumentInput,
  type RAGPipeline,
  type RAGPipelineConfig,
  type RetrievalQuery,
  type StoredChunk,
  type VectorStore,
} from './rag/index.js';
// Security
export {
  checkPromptSecurity,
  type AISecurityConfig,
  type SecurityCheckResult,
  type SecurityWarning,
} from './security.js';
// Usage API Client
export {
  createUsageAPIClient,
  UsageAPIError,
  type UsageAPIClient,
  type UsageClientConfig,
  type UsageData,
  type UsageEntry,
} from './usage-client.js';
// Output validation
export {
  generateWithValidation,
  type ValidatedResponse,
  type ValidationRetryConfig,
} from './validation.js';
