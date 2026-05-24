import { describe, expect, it } from 'vitest';
import { readChatStream } from '../client/event-stream.js';

describe('readChatStream', () => {
  it('parses SSE frames', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"message.delta","text":"Hi"}\n\ndata: {"type":"turn.completed","turnId":"1","usage":{"tokensIn":0,"tokensOut":0},"cost":0}\n\n',
          ),
        );
        controller.close();
      },
    });
    const res = new Response(body);
    const events = [];
    for await (const evt of readChatStream(res)) {
      events.push(evt);
    }
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe('message.delta');
  });
});
