export interface ChatUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface ChatBudget {
  perTurn?: { tokens?: number; costUsd?: number };
  perSession?: { turns?: number; userMessages?: number; tokens?: number; costUsd?: number };
  perUser?: { turnsPerHour?: number; turnsPerDay?: number; costUsdPerDay?: number };
  perTenant?: { costUsdPerDay?: number };
  contextTokens?: number;
  actions?: { perSession?: number };
  timeout?: { perTurnSeconds?: number };
}
