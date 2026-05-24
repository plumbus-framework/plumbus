import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const chatTurnPrompt = definePrompt({
  name: 'chat.turn',
  domain: 'chat',
  description: '{{systemPrompt}}\n\n{{userMessage}}',
  input: z.object({
    systemPrompt: z.string(),
    userMessage: z.string(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .optional(),
  }),
  output: z.object({
    inScope: z.boolean(),
    answer: z.string(),
    refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
    citedSources: z.array(z.string()),
    requestedAction: z
      .object({
        capabilityName: z.string(),
        input: z.unknown(),
        confirmationMessage: z.string(),
      })
      .nullable(),
  }),
  model: { temperature: 0.3, maxTokens: 800 },
});

export type ChatTurnModelOutput = z.infer<typeof chatTurnPrompt.output>;
