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
