import type { ChatEvent } from '@plumbus/chat';

export async function* readChatStream(response: Response): AsyncIterable<ChatEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const json = line.slice(6);
      if (!json.trim()) continue;
      yield JSON.parse(json) as ChatEvent;
    }
  }
}
