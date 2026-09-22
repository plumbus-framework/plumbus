import { createTestContext, type TestContextOptions } from '@plumbus/core/testing';
import { runChatTurn, type RunChatTurnOpts } from '../runtime/run-turn.js';
import type { ChatDefinition } from '../types/chat.js';
import { TraceRecorder } from '../eval/trace.js';
import type { ChatEvent } from '../types/event.js';

export async function mockChatRuntime(
  chat: ChatDefinition,
  input: {
    sessionId: string;
    userMessage: string;
    audience: string;
    locale: string;
  },
  options?: TestContextOptions,
  /** Exercise the chat against injected storage instead of the test context's `data`. */
  stores?: RunChatTurnOpts,
): Promise<{
  ctx: ReturnType<typeof createTestContext>;
  events: ChatEvent[];
  trace: TraceRecorder;
}> {
  const ctx = createTestContext(options);
  const trace = new TraceRecorder();
  const events: ChatEvent[] = [];
  for await (const evt of runChatTurn(
    ctx,
    {
      chatDefinition: chat,
      ...input,
      traceRecorder: trace,
    },
    stores,
  )) {
    events.push(evt);
    // run-turn's emit() already records into trace; do not double-record here.
  }
  return { ctx, events, trace };
}
