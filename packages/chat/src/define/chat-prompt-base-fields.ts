import { z } from '@plumbus/core/zod';

export const CHAT_PROMPT_BASE_OUTPUT_FIELDS = [
  'inScope',
  'answer',
  'refusalReason',
  'citedSources',
  'requestedAction',
] as const;

const warnedPrompts = new Set<string>();

/**
 * Warn once per prompt name when a custom chat prompt output schema omits required base fields.
 * With `answerSupplied` (the chat declares `answerOf`), `answer` is not required.
 */
export function warnMissingChatPromptBaseFields(
  prompt: { name?: string; output?: unknown },
  opts: { answerSupplied?: boolean } = {},
): void {
  const promptName = prompt.name ?? '(unnamed)';
  if (warnedPrompts.has(promptName)) return;
  const required = CHAT_PROMPT_BASE_OUTPUT_FIELDS.filter(
    (field) => !(opts.answerSupplied && field === 'answer'),
  );

  const output = prompt.output;
  if (!(output instanceof z.ZodObject)) {
    warnedPrompts.add(promptName);
    console.warn(
      `[@plumbus/chat] defineChat: custom prompt "${promptName}" output is not a Zod object — runtime guards require the base fields (${required.join(', ')}).`,
    );
    return;
  }

  const shape = output.shape;
  const missing = required.filter((field) => !(field in shape));
  if (missing.length > 0) {
    warnedPrompts.add(promptName);
    console.warn(
      `[@plumbus/chat] defineChat: custom prompt "${promptName}" output schema missing base fields: ${missing.join(', ')}`,
    );
  }
}
