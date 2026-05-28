import type { ChatEventEmitter } from './events.js';

export async function adaptModelStream(
  stream: AsyncIterable<{ type: string; text?: string }>,
  emitter: ChatEventEmitter,
): Promise<{
  data: Record<string, unknown>;
  usage: { tokensIn: number; tokensOut: number };
  model: string;
  cost: number;
}> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text_delta' && chunk.text) {
      text += chunk.text;
      emitter.emit({ type: 'message.delta', text: chunk.text });
    }
  }
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    return {
      data,
      usage: { tokensIn: 0, tokensOut: 0 },
      model: 'stream',
      cost: 0,
    };
  } catch {
    return {
      data: {
        inScope: true,
        answer: text,
        refusalReason: null,
        citedSources: [],
        requestedAction: null,
      },
      usage: { tokensIn: 0, tokensOut: 0 },
      model: 'stream',
      cost: 0,
    };
  }
}
