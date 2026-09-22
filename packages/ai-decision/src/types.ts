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
