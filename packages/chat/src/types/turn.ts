export interface TurnContext {
  sessionId: string;
  ordinal: number;
  userId: string;
  tenantId?: string;
  audience: string;
  locale: string;
  signal: AbortSignal;
  traceId: string;
  /** Stamped from `chat.budget?.contextTokens` before context resolution (registry-backed KB). */
  contextTokenBudget?: number;
  /** Post-`beforeTurn` user text for `queryFromTurn` on RAG-backed knowledge sources. */
  userMessage?: string;
}
