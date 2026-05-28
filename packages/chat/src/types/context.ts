import type { TurnContext } from './turn.js';

export interface ContextSource {
  kind: 'knowledge' | 'capability' | 'static';
  id: string;
  resolve(
    ctx: import('@plumbus/core').ExecutionContext,
    turnCtx: TurnContext,
  ): Promise<ResolvedContext>;
}

export interface ResolvedContext {
  items: ContextItem[];
  sources: ChatSourceRef[];
  estimatedTokens: number;
}

export interface ContextItem {
  id: string;
  kind: 'text' | 'json';
  content: unknown;
  sourceId?: string;
  classification?: 'public' | 'tenant' | 'user' | 'restricted';
  score?: number;
}

export interface ChatSourceRef {
  id: string;
  origin: 'knowledge' | 'capability' | 'static';
  label?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}
