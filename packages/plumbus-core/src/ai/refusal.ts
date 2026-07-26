import type { TokenUsage } from './provider.js';

const zeroUsage: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

export class AIRefusalError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly refusalText: string;
  readonly usage: TokenUsage;

  constructor(args: {
    provider: string;
    model: string;
    refusalText: string;
    usage?: TokenUsage;
  }) {
    super(`AI provider refused the request: ${args.refusalText}`);
    this.name = 'AIRefusalError';
    this.provider = args.provider;
    this.model = args.model;
    this.refusalText = args.refusalText;
    this.usage = args.usage ?? zeroUsage;
  }
}

export class AIIncompleteOutputError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly partialText: string;
  readonly usage: TokenUsage;
  readonly finishReason: string;

  constructor(args: {
    provider: string;
    model: string;
    partialText: string;
    usage?: TokenUsage;
    finishReason: string;
  }) {
    super(`AI provider stopped before completing structured output: ${args.finishReason}`);
    this.name = 'AIIncompleteOutputError';
    this.provider = args.provider;
    this.model = args.model;
    this.partialText = args.partialText;
    this.usage = args.usage ?? zeroUsage;
    this.finishReason = args.finishReason;
  }
}

/**
 * Thrown when an AI request is structurally invalid before any provider I/O —
 * e.g. caller tools combined with a tool-transport structured output, an
 * out-of-grammar tool name, or duplicate tool names. Bare `Error` with a name
 * string (same shape as AIRefusalError / AIIncompleteOutputError), NOT a
 * PlumbusError.
 */
export class AIInvalidRequestError extends Error {
  readonly reason: string;

  constructor(args: { reason: string; message?: string }) {
    super(args.message ?? `AI request is invalid: ${args.reason}`);
    this.name = 'AIInvalidRequestError';
    this.reason = args.reason;
  }
}
