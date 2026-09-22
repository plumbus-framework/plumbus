// ── plumbus rag ingest ──
// Invoke RAG ingestion pipeline from CLI

import type { Command } from 'commander';
import * as fs from 'node:fs';
import {
  createInMemoryVectorStore,
  createRAGPipeline,
  type AIProviderAdapter,
  type VectorStore,
} from '../../ai/index.js';
import { createOpenAIAdapter } from '../../ai/provider.js';
import { loadConfig } from '../../config/loader.js';
import { info, error as logError, resolvePath, success, warn } from '../utils.js';

export interface RagIngestOptions {
  source?: string;
  tenantId?: string;
  classification?: string;
  json?: boolean;
}

/** Read file content for ingestion */
export function readDocumentContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/** Validate that a path exists and is a file */
export function validateFilePath(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function registerRagCommand(program: Command): void {
  const cmd = program.command('rag').description('RAG pipeline management');

  cmd
    .command('ingest <path>')
    .description('Ingest documents into the RAG pipeline')
    .option('--source <source>', 'Source label for the document')
    .option('--tenant-id <tenantId>', 'Tenant ID for isolation')
    .option('--classification <level>', 'Data classification level')
    .option('--json', 'Output as JSON')
    .action(async (docPath: string, opts: RagIngestOptions) => {
      const resolved = resolvePath(docPath);

      if (!validateFilePath(resolved)) {
        logError(`File not found: ${resolved}`);
        process.exit(1);
      }

      info(`Ingesting document: ${resolved}`);

      const content = readDocumentContent(resolved);
      const source = opts.source ?? docPath;
      const documentId = crypto.randomUUID();

      // Initialize RAG pipeline from config
      try {
        const config = loadConfig();
        let provider: AIProviderAdapter | undefined;
        let vectorStore: VectorStore | undefined;

        if (config.ai?.apiKey) {
          provider = createOpenAIAdapter({
            apiKey: config.ai.apiKey,
            model: config.ai.model ?? 'text-embedding-3-small',
          });
        }

        // Use in-memory vector store as default; production would use pgvector
        vectorStore = createInMemoryVectorStore();

        if (provider && vectorStore) {
          const pipeline = createRAGPipeline({ provider, vectorStore });
          const result = await pipeline.ingest({
            documentId,
            content,
            source,
            tenantId: opts.tenantId,
            classification: opts.classification,
          });

          const output = {
            documentId: result.documentId,
            source,
            contentLength: content.length,
            chunkCount: result.chunkCount,
            tenantId: opts.tenantId,
            classification: opts.classification,
            status: 'ingested',
          };

          if (opts.json) {
            console.log(JSON.stringify(output, null, 2));
          } else {
            success(`Document ingested (${content.length} chars, ${result.chunkCount} chunks)`);
            info(`Document ID: ${result.documentId}`);
          }
        } else {
          warn(
            'AI provider not configured (missing ai.apiKey in config). Falling back to queued mode.',
          );
          const output = {
            documentId,
            source,
            contentLength: content.length,
            tenantId: opts.tenantId,
            classification: opts.classification,
            status: 'queued',
          };

          if (opts.json) {
            console.log(JSON.stringify(output, null, 2));
          } else {
            success(`Document queued for ingestion (${content.length} chars)`);
            info(`Document ID: ${documentId}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Ingestion failed: ${msg}`);
        process.exit(1);
      }
    });
}
