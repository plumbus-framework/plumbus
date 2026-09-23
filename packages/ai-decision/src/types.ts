/** JSON values accepted by decision providers. */
export type DecisionJson =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: DecisionJson }
  | readonly DecisionJson[];

export type DecisionState =
  | string
  | { readonly [key: string]: DecisionJson }
  | readonly DecisionJson[];
export type DecisionDescription = DecisionState;

export type DecisionQuestion =
  | {
      readonly type: 'choice';
      readonly instructions: DecisionDescription;
      readonly criteria: Readonly<Record<string, DecisionDescription | null>>;
    }
  | {
      readonly type: 'score';
      readonly instructions: DecisionDescription;
      readonly criteria: readonly DecisionDescription[];
    }
  | {
      readonly type: 'probability';
      readonly instructions: DecisionDescription;
      readonly criteria?: {
        readonly true?: DecisionDescription;
        readonly false?: DecisionDescription;
      };
    };

export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> {
  state: DecisionState;
  questions: Q;
  model?: string;
  /** One deadline across transport attempts, response reading, and retry delays. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DecisionChoiceAnswer<K extends string = string> {
  type: 'choice';
  choice: K;
  probabilities: Record<K, number>;
  /** Provider statistic; not the probability that the selected answer is correct. */
  confidence: number;
}

export interface DecisionScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, DecisionDescription>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface DecisionProbabilityAnswer {
  type: 'probability';
  probability: number;
  /** Some providers supply this; TypeSafe does not. Never synthesize it. */
  confidence?: number;
}

export type DecisionAnswerFor<T extends DecisionQuestion> = T extends {
  type: 'choice';
  criteria: infer C;
}
  ? DecisionChoiceAnswer<Extract<keyof C, string>>
  : T extends { type: 'score' }
    ? DecisionScoreAnswer
    : DecisionProbabilityAnswer;

export type DecisionAnswers<Q extends DecisionQuestions> = {
  -readonly [K in keyof Q]: DecisionAnswerFor<Q[K]>;
};

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DecisionResult<Q extends DecisionQuestions = DecisionQuestions> {
  answers: DecisionAnswers<Q>;
  provider: string;
  model: string;
  usage: DecisionUsage;
  /** USD estimate; null when unknown, including unpriced self-hosted inference. */
  cost: number | null;
  costAvailable: boolean;
  latencyMs: number;
  /** Provider routing information, not application actions or authorization. */
  routing?: { model: string; repo: string; reason: string };
}

/** Independent of core's text-completion AIProviderAdapter. */
export interface DecisionProviderAdapter {
  readonly name: string;
  decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<DecisionResult<Q>>;
}

export interface DecisionHttpConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Retries for 429, 529, and transient server errors only. Defaults to 2. */
  maxRetries?: number;
  /** Dependency injection for tests or a custom HTTP stack. */
  fetch?: typeof globalThis.fetch;
}

/** Reusable decision contract. The schema is validated by defineDecision(). */
export interface DecisionDefinition<Q extends DecisionQuestions = DecisionQuestions> {
  readonly kind: 'decision';
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly questions: Q;
  readonly state?: { parse(value: unknown): unknown };
  readonly provider?: string;
  readonly model?: string;
}

/** Application calls may use a named contract or inline questions. */
export type DecisionCall<Q extends DecisionQuestions = DecisionQuestions> = Omit<
  DecisionRequest<Q>,
  'state' | 'questions'
> & {
  state: unknown;
  provider?: string;
} & (
    | { questions: Q; decision?: never }
    | { decision: DecisionDefinition<Q>; questions?: never }
    | { decision: string; questions?: never }
  );

/** Explicit provider registration, shared by HTTP and worker bootstraps. */
export interface DecisionRuntimeConfig {
  providers: Readonly<Record<string, DecisionProviderAdapter>>;
  defaultProvider?: string;
  defaultModel?: string;
  definitions?: readonly DecisionDefinition[];
  registry?: { get(name: string): DecisionDefinition };
  /** Shared AI budget; applies to text and decision calls in the same runtime. */
  budget?: {
    maxTokensPerRequest?: number;
    dailyCostLimit?: number;
    perTenantDailyLimit?: number;
  };
}

/** Safe metadata for one completed provider invocation, including failed calls. */
export interface DecisionCallRecord {
  provider: string;
  model: string;
  decisionName?: string;
  usage: DecisionUsage;
  cost: number | null;
  latencyMs: number;
  status: 'success' | 'failed';
  errorMessage?: string;
}

/** Core supplies identity-bound security, budget, and ledger hooks. */
export interface DecisionRuntimeHooks {
  secure(input: Record<string, unknown>): Record<string, unknown>;
  checkBudget(estimatedTokens: number): void;
  record(record: DecisionCallRecord): Promise<void>;
}

/** Describes the lazy runtime entry without importing core-dependent implementation. */
export interface DecisionRuntimeModule {
  defineDecision<Q extends DecisionQuestions>(
    input: Omit<DecisionDefinition<Q>, 'kind'>,
  ): DecisionDefinition<Q>;
  runDecision<Q extends DecisionQuestions>(
    call: DecisionCall<Q>,
    config: DecisionRuntimeConfig | undefined,
    hooks: DecisionRuntimeHooks,
  ): Promise<DecisionResult<Q>>;
}
