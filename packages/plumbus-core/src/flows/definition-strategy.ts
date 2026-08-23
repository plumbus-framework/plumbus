// In-flight definition strategies (Plan 02 Stage 5 / D-02-4).
// v1 implements complete-on-original and stop-and-recover.
// migrate is refused with a stable error — not a silent no-op.

import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';

export const DEFINITION_STRATEGY_NOT_SUPPORTED = 'definition-strategy-not-supported' as const;

export const DefinitionInFlightStrategy = {
  CompleteOnOriginal: 'complete-on-original',
  StopAndRecover: 'stop-and-recover',
  Migrate: 'migrate',
} as const;

export type DefinitionInFlightStrategy =
  (typeof DefinitionInFlightStrategy)[keyof typeof DefinitionInFlightStrategy];

export class DefinitionStrategyNotSupportedError extends PlumbusError {
  constructor(strategy: string) {
    super(ErrorCode.Validation, `Definition in-flight strategy "${strategy}" is not supported`, {
      reason: DEFINITION_STRATEGY_NOT_SUPPORTED,
      strategy,
    });
    this.name = 'DefinitionStrategyNotSupportedError';
  }
}

export function assertSupportedDefinitionStrategy(
  strategy: string,
): asserts strategy is Exclude<
  DefinitionInFlightStrategy,
  typeof DefinitionInFlightStrategy.Migrate
> {
  if (strategy === DefinitionInFlightStrategy.Migrate || strategy === 'migrate') {
    throw new DefinitionStrategyNotSupportedError(DefinitionInFlightStrategy.Migrate);
  }
  if (
    strategy !== DefinitionInFlightStrategy.CompleteOnOriginal &&
    strategy !== DefinitionInFlightStrategy.StopAndRecover
  ) {
    throw new DefinitionStrategyNotSupportedError(strategy);
  }
}
