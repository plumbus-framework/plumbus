// ── RAG Barrel Export ──
export { chunkDocument, type ChunkConfig, type DocumentChunk } from "./chunking.js";
export {
    createInMemoryVectorStore, createRAGPipeline, type IngestDocumentInput, type RAGPipeline,
    type RAGPipelineConfig, type RetrievalQuery, type StoredChunk, type VectorStore
} from "./pipeline.js";
export { documentChunksTable, documentsTable } from "./schema.js";

