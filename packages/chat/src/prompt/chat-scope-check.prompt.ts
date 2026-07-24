// packages/chat/src/prompt/chat-scope-check.prompt.ts
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const chatScopeCheckPrompt = definePrompt({
  name: 'chat.scopeCheck',
  domain: 'chat',
  description:
    '{{systemPrompt}}\n\nClassify ONLY whether the following user message is in scope for this assistant. Do NOT answer it.\nUser message: {{userMessage}}\n\nReturn inScope=true if it is on-topic and safe to handle; otherwise inScope=false with a refusalReason.',
  input: z.object({
    systemPrompt: z.string(),
    userMessage: z.string(),
  }),
  output: z.object({
    inScope: z.boolean(),
    refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
  }),
  model: { temperature: 0, maxTokens: 64 },
});

export type ChatScopeCheckOutput = z.infer<typeof chatScopeCheckPrompt.output>;
