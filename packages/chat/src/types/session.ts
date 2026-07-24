import type { ChatSourceRef } from './context.js';
import type { ToolExecutionRecord } from './tool.js';

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
  revision: number;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | string | null;
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
  logicalTurnId?: string;
  continuationOfTurnId?: string;
  toolsExecuted?: ToolExecutionRecord[];
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
