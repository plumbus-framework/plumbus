export interface TurnContext {
  sessionId: string;
  ordinal: number;
  userId: string;
  tenantId?: string;
  audience: string;
  locale: string;
  signal: AbortSignal;
  traceId: string;
}
