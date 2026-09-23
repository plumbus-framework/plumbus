/** Structured decision-provider errors with safe, bounded metadata. */
import { PlumbusError } from '@plumbus/core';
import type { DecisionUsage } from '../types.js';

export type DecisionErrorKind =
  | 'configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'http'
  | 'network'
  | 'timeout'
  | 'cancelled';

export class DecisionProviderError extends PlumbusError {
  readonly kind: DecisionErrorKind;
  readonly provider: string;
  readonly httpStatus?: number;
  readonly attempts?: number;
  readonly usage?: DecisionUsage;
  readonly model?: string;
  readonly cost?: number | null;

  constructor(
    provider: string,
    kind: DecisionErrorKind,
    message: string,
    details: {
      httpStatus?: number;
      attempts?: number;
      usage?: DecisionUsage;
      model?: string;
      cost?: number | null;
    } = {},
  ) {
    super(
      kind === 'cancelled'
        ? 'cancelled'
        : kind === 'configuration' || kind === 'invalid_request'
          ? 'validation'
          : 'internal',
      message,
      { provider, kind, ...details },
    );
    this.name = 'DecisionProviderError';
    this.provider = provider;
    this.kind = kind;
    this.httpStatus = details.httpStatus;
    this.attempts = details.attempts;
    this.usage = details.usage;
    this.model = details.model;
    this.cost = details.cost;
  }
}
