// ── AI Module ──
// AI runtime: provider adapters (OpenAI, Anthropic), decision providers,
// prompt registry, output validation, cost tracking, security scanning,
// explainability, and RAG pipeline. Used by ctx.ai in capability handlers.
//
// Key exports: createAIService, createRAGPipeline, PromptRegistry,
// checkPromptSecurity, noul/choice/score

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
// Decision primitive (ctx.ai.decide)
export {
  choice,
  noul,
  score,
  validateDecisionQuestions,
  DECISION_LIMITS,
  type AnswerFor,
  type AnswersFor,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionInstructions,
  type DecisionModel,
  type DecisionProviderAdapter,
  type DecisionProviderCapabilities,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResponse,
  type NoulAnswer,
  type NoulCriteria,
  type NoulQuestion,
  type ScoreAnswer,
  type ScoreQuestion,
} from './decision.js';
export { DecisionRegistry } from './decision-registry.js';
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
  estimateModelCost,
  findModelRate,
  type Kind,
  type ModelRate,
} from './model-pricing.js';
// Prompt registry
export { PromptRegistry } from './prompt-registry.js';
// Provider adapters
export {
  createAnthropicAdapter,
  createDecisionAdapter,
  createOpenAIAdapter,
  createProviderAdapter,
  isProviderAPIError,
  joinAndFilterModels,
  normalizeFinishReason,
  ProviderAPIError,
  type AIProviderAdapter,
  type AIProviderCapabilities,
  type ProviderClassifyRequest,
  type ProviderClassifyResponse,
  type AITool,
  type AIToolCall,
  type AIToolChoice,
  type AIToolExecutionOptions,
  type ChatMessage,
  type AnthropicAdapterConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ListModelsFilter,
  type OpenAIAdapterConfig,
  type ProviderAssistantState,
  type ProviderModel,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamEvent,
  type TokenUsage,
} from './provider.js';
// Bounded provider-native tool loop
export {
  runToolLoop,
  safeJsonStringify,
  type RunToolLoopParams,
  type RunToolLoopResult,
} from './tool-loop.js';
// Provider-side structured output errors
export { AIIncompleteOutputError, AIInvalidRequestError, AIRefusalError } from './refusal.js';
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
