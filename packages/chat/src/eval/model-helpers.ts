import type {
  ChatConversationJudge,
  ChatEvalTurnRecord,
  ChatTurnJudge,
  ChatUserSimulator,
} from '../define/defineChatEvaluation.js';
import { delimitedConversationJson } from '../history/summarizer.js';

/** The conversation as the helpers send it: user/assistant pairs, delimited-safe JSON. */
function transcriptJson(transcript: ChatEvalTurnRecord[]): string {
  return delimitedConversationJson(
    transcript.map((t) => ({
      user: t.userMessage,
      assistant: t.reply,
      ...(t.failureCode ? { failed: t.failureCode } : {}),
    })),
  );
}

/**
 * A simulated user backed by an app-registered prompt (the persona). Each turn
 * calls `ctx.ai.generateWithUsage({ prompt, input })` with
 * `{ ...persona, transcript, turnIndex }` — `transcript` is the conversation so
 * far as JSON (`[{ user, assistant }]`, with `<`/`>`/`&` escaped so the prompt
 * can wrap it in delimiters) — and reads `{ message: string | null }` from the
 * output. `null`, an empty message, or `done: true` ends the conversation.
 *
 * The prompt is the app's: its instructions describe who the user is and what
 * they want. Calls are recorded under `serviceArea: 'chat-eval'`.
 */
export function promptUserSimulator(config: {
  prompt: string;
  persona?: Record<string, unknown>;
}): ChatUserSimulator {
  return async ({ ctx, transcript, turnIndex }) => {
    const { data } = await ctx.ai.generateWithUsage({
      prompt: config.prompt,
      input: { ...(config.persona ?? {}), transcript: transcriptJson(transcript), turnIndex },
      costContext: { serviceArea: 'chat-eval', operationName: `chat-eval.${config.prompt}` },
    });
    const out = (data ?? {}) as { message?: unknown; done?: unknown };
    if (out.done === true) return null;
    return typeof out.message === 'string' ? out.message : null;
  };
}

/**
 * A model judge backed by an app-registered prompt. It works as a per-turn
 * judge (`perTurn.judge`, a scripted turn's `judge`) and as a whole-conversation
 * judge (`scenario.judge`). Input: `{ ...criteria, transcript, turn }` where
 * `turn` is the judged turn as JSON (empty string for a conversation judge).
 * Output: `{ pass: boolean, reason?: string }`. A missing or non-boolean `pass`
 * is a failure (the conservative default).
 */
export function promptJudge(config: {
  prompt: string;
  criteria?: Record<string, unknown>;
}): ChatTurnJudge & ChatConversationJudge {
  return async (args: {
    ctx: Parameters<ChatConversationJudge>[0]['ctx'];
    transcript: ChatEvalTurnRecord[];
    turn?: ChatEvalTurnRecord;
  }) => {
    const { data } = await args.ctx.ai.generateWithUsage({
      prompt: config.prompt,
      input: {
        ...(config.criteria ?? {}),
        transcript: transcriptJson(args.transcript),
        turn: args.turn ? transcriptJson([args.turn]) : '',
      },
      costContext: { serviceArea: 'chat-eval', operationName: `chat-eval.${config.prompt}` },
    });
    const out = (data ?? {}) as { pass?: unknown; reason?: unknown };
    return {
      pass: out.pass === true,
      ...(typeof out.reason === 'string' ? { reason: out.reason } : {}),
    };
  };
}
