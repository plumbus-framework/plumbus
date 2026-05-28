export const CLIENT_HISTORY_MAX_MESSAGES = 20;
export const CLIENT_HISTORY_MAX_CHARS = 4000;

export type ClientHistoryRefusalReason =
  | 'off_topic'
  | 'unsafe'
  | 'asking_for_action'
  | 'pii_request';

export interface ClientHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Set on assistant messages that were refusals; lets the behavioral guard
   * enforce cooldowns from clientHistory when `saveToDb: false`. */
  refusalReason?: ClientHistoryRefusalReason | null;
}

export function capClientHistory(
  history: ClientHistoryMessage[] | undefined,
): ClientHistoryMessage[] {
  if (!history) return [];
  const sliced = history.slice(-CLIENT_HISTORY_MAX_MESSAGES);
  return sliced.map((m) => ({
    role: m.role,
    content: m.content.slice(0, CLIENT_HISTORY_MAX_CHARS),
    refusalReason: m.refusalReason ?? null,
  }));
}

export function validateClientHistorySize(history: ClientHistoryMessage[] | undefined): void {
  if (!history) return;
  if (history.length > CLIENT_HISTORY_MAX_MESSAGES) {
    throw new Error('chat.client_history_too_large');
  }
  for (const m of history) {
    if (m.content.length > CLIENT_HISTORY_MAX_CHARS) {
      throw new Error('chat.client_history_too_large');
    }
  }
}
