import type { ChatSourceRef } from './context.js';

export interface ChatSessionRow {
  id: string;
  chatName: string;
  userId: string;
  tenantId?: string;
  audience: string;
  locale: string;
  startedAt: Date;
  lastTurnAt: Date;
  status: 'active' | 'ended';
  behavioralState: Record<string, unknown>;
  summaryText?: string;
  summaryTurnCount: number;
}

export interface ChatTurnRow {
  id: string;
  sessionId: string;
  ordinal: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  inScope: boolean;
  refusalReason?: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request';
  sources: ChatSourceRef[];
  actionRequested?: { capabilityName: string; input: unknown };
  actionConfirmed?: boolean;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  latencyMs: number;
  recordedAt: Date;
  userId: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
