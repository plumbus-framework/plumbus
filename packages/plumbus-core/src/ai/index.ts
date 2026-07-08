// ── AI Module ──
// AI runtime: provider adapters (OpenAI, Anthropic), prompt registry, output
// validation, cost tracking, security scanning, explainability, and RAG pipeline.
// Used by ctx.ai in capability handlers.
//
// Key exports: createAIService, createRAGPipeline, PromptRegistry, checkPromptSecurity

// AI Service
export {
  createAIService,
  singleProviderConfig,
  type AICostContext,
  type AIServiceConfig,
  type OnAICostRecorded,
} from './ai-service.js';
// Cost tracking
export {
  createCostTracker,
  type AICostRecord,
  type AICostRecordInput,
  type BudgetCheckResult,
  type BudgetConfig,
  type CostTracker,
  type DailyUsage,
  type UsageSyncResult,
} from './cost-tracker.js';
export {
  deriveLedgerUsage,
  type DerivedLedgerUsage,
  type LedgerUsageKind,
} from './derive-ledger-usage.js';
// Explainability
export {
  createExplainabilityTracker,
  type AIExplainabilityTracker,
  type AIInvocationRecord,
  type ExplainabilityConfig,
} from './explainability.js';
// Model pricing
export {
  allKnownModels,
  calculateModelCost,
  findModelRate,
  type Kind,
  type ModelRate,
} from './model-pricing.js';
// Prompt registry
export { PromptRegistry } from './prompt-registry.js';
// Provider adapters
export {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createProviderAdapter,
  joinAndFilterModels,
  type AIProviderAdapter,
  type ChatMessage,
  type AnthropicAdapterConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ListModelsFilter,
  type OpenAIAdapterConfig,
  type ProviderModel,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamEvent,
  type TokenUsage,
} from './provider.js';
// Provider-side structured output errors
export { AIIncompleteOutputError, AIRefusalError } from './refusal.js';
// Provider-compatible schema conversion
export {
  ProviderJsonSchemaError,
  zodToProviderJsonSchema,
  type ProviderJsonSchemaOptions,
  type ProviderJsonSchemaResult,
} from './zod-to-provider-schema.js';
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
  buildAISecurityConfig,
  checkPromptSecurity,
  type AISecurityConfig,
  type AISecurityMode,
  type SecurityCheckResult,
  type SecurityWarning,
} from './security.js';
// Usage API Client
export {
  UsageAPIError,
  createUsageAPIClient,
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
