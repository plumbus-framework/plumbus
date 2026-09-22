import type { KnowledgeScope } from './scope.js';

export interface SearchResult {
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface ScoredBlock {
  text: string;
  score: number;
  scope?: KnowledgeScope;
}
