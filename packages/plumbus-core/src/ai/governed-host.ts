/**
 * Host-provided model for governed AI.
 *
 * The host owns credentials, transport, and which models exist. The framework
 * never falls back to an unregistered provider or model.
 */

export interface GovernedModelPin {
  providerId: string;
  modelId: string;
  /** Digest of a published prompt artifact. */
  promptDigest: string;
  /** Digest of a published policy artifact. */
  policyDigest: string;
}

export interface GovernedModelRequest {
  prompt: string;
  system?: string;
  input?: unknown;
}

export interface GovernedModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GovernedModelResult {
  text: string;
  usage?: GovernedModelUsage;
  costUsd?: number | null;
}

export interface GovernedModel {
  readonly providerId: string;
  readonly modelId: string;
  complete(request: GovernedModelRequest): Promise<GovernedModelResult>;
}

export interface GovernedBudgetCheckInput {
  tenantId?: string;
  estimatedTokens?: number;
  estimatedCostUsd?: number;
  pin: GovernedModelPin;
}

export interface GovernedBudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface GovernedAiHost {
  /** Look up the host model for this pin. `undefined` fails closed — no fallback. */
  resolveModel(pin: GovernedModelPin): Promise<GovernedModel | undefined>;
  /**
   * Host budget authority. Omitted, unknown, or refused spend fails closed;
   * the framework will not call the model.
   */
  checkBudget(input: GovernedBudgetCheckInput): Promise<GovernedBudgetCheckResult>;
}
