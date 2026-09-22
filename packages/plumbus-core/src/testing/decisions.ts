// ── Decision Test Helpers ──
// A DecisionProviderAdapter that answers from a fixture instead of the
// network, so tests can exercise `ctx.ai.decide()` end to end — including cost
// recording, budget checks, and explainability — without an API key.

import type {
  DecisionAnswer,
  DecisionProviderAdapter,
  DecisionRequest,
  DecisionResponse,
} from '../ai/decision.js';

export interface StubDecisionAdapterOptions {
  /** Adapter name, as registered in `decisionProviders`. Defaults to `"stub"`. */
  name?: string;
  /** Model id reported on the response. Defaults to `"stub-decision-model"`. */
  model?: string;
  /**
   * Answers keyed by question id. A question with no entry here throws, so a
   * test that adds a question without an expectation fails loudly rather than
   * silently asserting on a placeholder.
   */
  answers: Record<string, DecisionAnswer>;
  /** Fixed input token count reported per call. Defaults to 100. */
  inputTokens?: number;
  /** Fixed USD cost reported per call. Omit to let the pricing catalog decide. */
  cost?: number;
  /** Throw this instead of answering, to exercise failure paths. */
  error?: Error;
}

export interface StubDecisionAdapter extends DecisionProviderAdapter {
  /** Every request the adapter received, in order. */
  readonly requests: DecisionRequest[];
}

/** Create a decision provider adapter that answers from a fixture. */
export function createStubDecisionAdapter(
  options: StubDecisionAdapterOptions,
): StubDecisionAdapter {
  const requests: DecisionRequest[] = [];
  const inputTokens = options.inputTokens ?? 100;

  return {
    name: options.name ?? 'stub',
    requests,
    async decide(request): Promise<DecisionResponse> {
      requests.push(request);
      if (options.error) throw options.error;

      const answers: Record<string, DecisionAnswer> = {};
      for (const id of Object.keys(request.questions)) {
        const answer = options.answers[id];
        if (!answer) {
          throw new Error(
            `createStubDecisionAdapter: no stubbed answer for question "${id}". Add it to \`answers\`.`,
          );
        }
        answers[id] = answer;
      }

      return {
        model: request.model ?? options.model ?? 'stub-decision-model',
        answers,
        usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
        ...(options.cost != null ? { cost: options.cost } : {}),
      };
    },
  };
}
