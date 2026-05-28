import type { ExecutionContext } from '@plumbus/core';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';
import { updateSessionSummary } from '../session/service.js';

export async function maybeSummarize(
  ctx: ExecutionContext,
  session: ChatSessionRow,
  history: ChatTurnRow[],
  opts?: {
    strategy?: 'rolling' | 'threshold';
    thresholdTurns?: number;
    targetTokens?: number;
  },
): Promise<{ summary: string; turnsConsumed: number } | null> {
  if (!opts?.thresholdTurns) return null;
  const total = session.summaryTurnCount + history.length;
  if (total <= opts.thresholdTurns) return null;

  const older = history.slice(0, Math.max(0, history.length - 4));
  const turnsText = older.map((t) => `${t.role}: ${t.content}`).join('\n');
  const { data } = await ctx.ai.generateWithUsage({
    prompt: 'chat.summarize.history',
    input: {
      previousSummary: session.summaryText ?? '',
      turnsText,
    },
  });

  const summary = (data as { summary?: string }).summary ?? '';
  await updateSessionSummary(ctx, session.id, summary, session.summaryTurnCount + older.length);

  return { summary, turnsConsumed: older.length };
}
