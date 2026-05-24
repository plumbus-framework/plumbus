export const CLIENT_HISTORY_MAX_MESSAGES = 20;
export const CLIENT_HISTORY_MAX_CHARS = 4000;

export function capClientHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!history) return [];
  const sliced = history.slice(-CLIENT_HISTORY_MAX_MESSAGES);
  return sliced.map((m) => ({
    role: m.role,
    content: m.content.slice(0, CLIENT_HISTORY_MAX_CHARS),
  }));
}

export function validateClientHistorySize(
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): void {
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
