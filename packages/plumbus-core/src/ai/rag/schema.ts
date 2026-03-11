// ── RAG Schema (pgvector tables) ──

import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

// ── Document Chunks Table ──
export const documentChunksTable = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: varchar("document_id", { length: 255 }).notNull(),
    content: text("content").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    // Embedding stored as JSON array (pgvector requires extension; JSON is portable fallback)
    // In production with pgvector, replace with: vector("embedding", { dimensions: 1536 })
    embedding: jsonb("embedding"),
    source: varchar("source", { length: 1024 }),
    tenantId: varchar("tenant_id", { length: 255 }),
    classification: varchar("classification", { length: 50 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("document_chunks_document_id_idx").on(t.documentId),
    index("document_chunks_tenant_id_idx").on(t.tenantId),
  ],
);

// ── Document Metadata Table ──
export const documentsTable = pgTable(
  "documents",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    source: varchar("source", { length: 1024 }).notNull(),
    tenantId: varchar("tenant_id", { length: 255 }),
    classification: varchar("classification", { length: 50 }),
    chunkCount: integer("chunk_count").notNull().default(0),
    metadata: jsonb("metadata"),
    ingestedAt: timestamp("ingested_at").defaultNow().notNull(),
  },
  (t) => [index("documents_tenant_id_idx").on(t.tenantId)],
);
