// packages/chat/src/prompt/chat-tool-round.prompt.ts
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const chatToolRoundPrompt = definePrompt({
  name: 'chat.toolRound',
  domain: 'chat',
  description:
    '{{systemPrompt}}\n\nUser message: {{userMessage}}\n\nYou may call the provided tools to gather information or perform allowed read actions. Call a tool when it helps answer the user. When you have gathered enough information, STOP calling tools and reply with a brief acknowledgement — a separate step composes the final answer.',
  input: z.object({
    systemPrompt: z.string(),
    userMessage: z.string(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .optional(),
  }),
  // Output is NOT schema-validated during tool rounds: callers pass
  // outputValidation:'none' and attach provider tools. Permissive so definePrompt
  // accepts it and no structured-output response schema is forced.
  output: z.object({ acknowledgement: z.string().optional() }).passthrough(),
  model: { temperature: 0.2, maxTokens: 800 },
  disableStrictStructuredOutputs: true,
});
