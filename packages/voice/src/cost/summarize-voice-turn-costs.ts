import type { AICostRecord } from '@plumbus/core';

export interface VoiceCostLedgerEntry {
  record: AICostRecord;
  costContext?: {
    relatedEntityId?: string;
    operationName?: string;
  };
}

export interface VoiceTurnCostSummary {
  sessionId: string;
  turnId: string;
  transcribeUsd: number | null;
  synthesizeUsd: number | null;
  brainUsd: number | null;
  transportUsdAmortized: number | null;
  totalUsd: number | null;
  costAvailable: boolean;
}

export function summarizeVoiceTurnCosts(
  entries: readonly VoiceCostLedgerEntry[],
  sessionId: string,
  turnId: string,
  options: { transportUsd?: number | null; turnCount?: number } = {},
): VoiceTurnCostSummary {
  const inWindow = entries.filter((entry) => matchesTurn(entry, sessionId, turnId));

  const transcribeUsd = sumCost(inWindow, 'transcribe');
  const synthesizeUsd = sumCost(inWindow, 'synthesize');
  const brainUsd = sumCost(inWindow, 'generate');
  const transportUsdAmortized =
    options.transportUsd !== undefined
      ? amortizeTransport(options.transportUsd, options.turnCount ?? 1)
      : null;

  const parts = [transcribeUsd, synthesizeUsd, brainUsd, transportUsdAmortized].filter(
    (value): value is number => value !== null,
  );
  const costAvailable = parts.length > 0 || inWindow.some((entry) => entry.record.cost !== null);
  const totalUsd = parts.length > 0 ? roundUsd(parts.reduce((sum, value) => sum + value, 0)) : null;

  return {
    sessionId,
    turnId,
    transcribeUsd,
    synthesizeUsd,
    brainUsd,
    transportUsdAmortized,
    totalUsd,
    costAvailable,
  };
}

function matchesTurn(entry: VoiceCostLedgerEntry, sessionId: string, turnId: string): boolean {
  const context = entry.costContext;
  if (context?.relatedEntityId !== sessionId) {
    return false;
  }
  if (!context.operationName) {
    return true;
  }
  return context.operationName === turnId || context.operationName.startsWith(`${turnId}:`);
}

function sumCost(
  entries: readonly VoiceCostLedgerEntry[],
  operation: AICostRecord['operation'],
): number | null {
  const matching = entries.filter((entry) => entry.record.operation === operation);
  if (matching.length === 0) {
    return null;
  }

  if (matching.some((entry) => entry.record.cost === null)) {
    return null;
  }

  return roundUsd(matching.reduce((sum, entry) => sum + (entry.record.cost ?? 0), 0));
}

function amortizeTransport(transportUsd: number | null, turnCount: number): number | null {
  if (transportUsd === null) {
    return null;
  }
  return roundUsd(transportUsd / Math.max(1, turnCount));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
