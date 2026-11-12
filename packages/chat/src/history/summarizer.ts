import type { ExecutionContext } from '@plumbus/core';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';
import type { ChatHistorySummarizeConfig } from '../types/chat.js';
import { resolveChatSessionStore, type ChatSessionStore } from '../session/session-store.js';

/** Turns kept verbatim (outside the summary) when a summary is written. */
const KEEP_RECENT_TURNS = 4;

/** BCP 47 language tag shape (a structured format). */
const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * JSON for embedding inside the `<conversation_data>` delimiters: `<`, `>` and
 * `&` are escaped so no turn text can close the delimiter or open another tag.
 * The model reads the escapes as the original characters.
 */
export function delimitedConversationJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** The summary's language line. Only a well-formed tag is ever placed in the prompt. */
export function summaryLanguageInstruction(locale: string | undefined): string {
  if (locale && LOCALE_TAG.test(locale)) {
    return `Write the summary in the language of locale "${locale}".`;
  }
  return 'Write the summary in the language the conversation is conducted in.';
}

/**
 * Rolling summary of the turns not yet summarized. Runs when more than
 * `thresholdTurns` turns are outside the summary, folds all but the last four of
 * them into it, and records how many turns the summary now covers. On a turn
 * where it does not run, the stored summary (if any) is returned unchanged.
 *
 * `windowTurns` is the history window sent verbatim (`includeLastTurns`). Once a
 * summary exists it also runs whenever an unsummarized turn would fall outside
 * that window, and keeps at most `windowTurns` turns out of the summary, so every
 * earlier turn is either in the summary or in the window.
 *
 * The turns and the previous summary reach the model as delimited JSON data,
 * never interpolated raw; the summary is written in `locale` (default: the
 * conversation's locale).
 */
export async function maybeSummarize(
  ctx: ExecutionContext,
  session: ChatSessionRow,
  history: ChatTurnRow[],
  opts?: Partial<ChatHistorySummarizeConfig>,
  sessionStore?: ChatSessionStore,
  conversation?: { conversationLocale?: string; windowTurns?: number },
): Promise<{ summary: string; turnsConsumed: number } | null> {
  if (!opts?.thresholdTurns) return null;
  const alreadySummarized = Math.min(session.summaryTurnCount ?? 0, history.length);
  const pending = history.slice(alreadySummarized);
  const stored = session.summaryText ? { summary: session.summaryText, turnsConsumed: 0 } : null;
  const windowTurns = conversation?.windowTurns;
  const outsideWindow =
    alreadySummarized > 0 && windowTurns !== undefined && pending.length > windowTurns;
  if (pending.length <= opts.thresholdTurns && !outsideWindow) return stored;

  const keep =
    windowTurns === undefined ? KEEP_RECENT_TURNS : Math.min(KEEP_RECENT_TURNS, windowTurns);
  const older = pending.slice(0, Math.max(0, pending.length - keep));
  if (older.length === 0) return stored;
  const locale =
    opts.locale === undefined || opts.locale === 'conversation'
      ? conversation?.conversationLocale
      : opts.locale;
  const { data } = await ctx.ai.generateWithUsage({
    prompt: 'chat.summarize.history',
    input: {
      conversationData: delimitedConversationJson({
        previousSummary: session.summaryText ?? '',
        turns: older.map((t) => ({ role: t.role, content: t.content })),
      }),
      languageInstruction: summaryLanguageInstruction(locale),
    },
    costContext: { serviceArea: 'chat', operationName: `chat.${session.chatName}.summarize` },
  });

  const summary = (data as { summary?: string }).summary ?? '';
  await resolveChatSessionStore(sessionStore).updateSessionSummary(
    ctx,
    session.id,
    summary,
    alreadySummarized + older.length,
  );

  return { summary, turnsConsumed: older.length };
}
