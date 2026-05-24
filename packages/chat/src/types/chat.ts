import type { AccessPolicy } from '@plumbus/core';
import type { PromptDefinition } from '@plumbus/core';
import type { z } from '@plumbus/core/zod';
import type { ChatBudget } from './budget.js';
import type { ContextSource } from './context.js';
import type { ChatPolicy } from './policy.js';

export type ChatExposeAs = 'capability' | 'sse' | 'both';

export type MessagePersistence = 'server' | 'client';

export interface ChatHistoryConfig {
  includeLastTurns?: number;
  summarize?: {
    strategy: 'rolling' | 'threshold';
    thresholdTurns?: number;
    targetTokens?: number;
  };
}

export interface ChatConfig {
  name: string;
  description?: string;
  access: AccessPolicy;
  context?: ContextSource[];
  actions?: string[];
  policy?: ChatPolicy;
  budget?: ChatBudget;
  history?: ChatHistoryConfig;
  instructions?: string[];
  prompt?: PromptDefinition<z.ZodTypeAny, z.ZodTypeAny>;
  persistence?: { messageContent: MessagePersistence };
  exposeAs?: ChatExposeAs;
}

export interface ChatDefinition extends ChatConfig {
  kind: 'chat';
}
