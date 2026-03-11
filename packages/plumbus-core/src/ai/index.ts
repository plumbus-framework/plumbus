// ── AI Module Barrel Export ──

// Provider adapters
export {
    createAnthropicAdapter, createOpenAIAdapter, type AIProviderAdapter, type AnthropicAdapterConfig, type EmbeddingRequest,
    type EmbeddingResponse,
    type OpenAIAdapterConfig, type ProviderRequest,
    type ProviderResponse,
    type ProviderStreamEvent,
    type TokenUsage
} from "./provider.js";

// Prompt registry
export { PromptRegistry } from "./prompt-registry.js";

// AI Service
export { createAIService, type AIServiceConfig } from "./ai-service.js";

// Output validation
export {
    generateWithValidation, type ValidatedResponse, type ValidationRetryConfig
} from "./validation.js";

// Cost tracking
export {
    createCostTracker,
    estimateCost, type AICostRecord, type BudgetCheckResult, type BudgetConfig, type CostTracker, type DailyUsage
} from "./cost-tracker.js";

// Security
export {
    checkPromptSecurity,
    type AISecurityConfig,
    type SecurityCheckResult,
    type SecurityWarning
} from "./security.js";

// Explainability
export {
    createExplainabilityTracker,
    type AIExplainabilityTracker,
    type AIInvocationRecord,
    type ExplainabilityConfig
} from "./explainability.js";

// RAG pipeline
export {
    chunkDocument, createInMemoryVectorStore, createRAGPipeline, documentChunksTable,
    documentsTable, type ChunkConfig,
    type DocumentChunk, type IngestDocumentInput, type RAGPipeline,
    type RAGPipelineConfig, type RetrievalQuery, type StoredChunk, type VectorStore
} from "./rag/index.js";

