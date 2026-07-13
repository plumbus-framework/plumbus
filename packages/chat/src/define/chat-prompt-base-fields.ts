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
 */
export function warnMissingChatPromptBaseFields(prompt: { name?: string; output?: unknown }): void {
  const promptName = prompt.name ?? '(unnamed)';
  if (warnedPrompts.has(promptName)) return;

  const output = prompt.output;
  if (!(output instanceof z.ZodObject)) {
    warnedPrompts.add(promptName);
    console.warn(
      `[@plumbus/chat] defineChat: custom prompt "${promptName}" output is not a Zod object — runtime guards require the five base fields (${CHAT_PROMPT_BASE_OUTPUT_FIELDS.join(', ')}).`,
    );
    return;
  }

  const shape = output.shape;
  const missing = CHAT_PROMPT_BASE_OUTPUT_FIELDS.filter((field) => !(field in shape));
  if (missing.length > 0) {
    warnedPrompts.add(promptName);
    console.warn(
      `[@plumbus/chat] defineChat: custom prompt "${promptName}" output schema missing base fields: ${missing.join(', ')}`,
    );
  }
}
