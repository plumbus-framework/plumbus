import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const chatSummarizeHistoryPrompt = definePrompt({
  name: 'chat.summarize.history',
  domain: 'chat',
  description:
    'Summarize prior conversation turns.\n\nPrevious summary:\n{{previousSummary}}\n\nTurns:\n{{turnsText}}',
  input: z.object({
    previousSummary: z.string(),
    turnsText: z.string(),
  }),
  output: z.object({ summary: z.string() }),
  model: { temperature: 0.2, maxTokens: 400 },
});
