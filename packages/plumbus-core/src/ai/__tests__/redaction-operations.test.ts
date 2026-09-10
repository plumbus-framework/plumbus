import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import type { AIProviderAdapter } from '../provider.js';
import { createExplainabilityTracker } from '../explainability.js';

it.each([
  'extract',
  'classify',
] as const)('redacts %s text in provider requests and explainability', async (operation) => {
  const complete = vi.fn(async () => ({
    content: operation === 'extract' ? '{"ok":true}' : '["ok"]',
    model: 'local',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }));
  const provider = { name: 'local', complete } as unknown as AIProviderAdapter;
  const tracker = createExplainabilityTracker();
  const service = createAIService(
    singleProviderConfig(provider, {
      explainability: tracker,
      security: {
        entities: [
          {
            name: 'PrivateText',
            fields: { text: { type: 'string', options: { classification: 'highly_sensitive' } } },
          },
        ],
      },
    }),
  );
  if (operation === 'extract')
    await service.extract({ text: 'private data', schema: z.object({ ok: z.boolean() }) });
  else await service.classify({ text: 'private data', labels: ['ok'] });
  expect(JSON.stringify(complete.mock.calls)).not.toContain('private data');
  expect(JSON.stringify(complete.mock.calls)).toContain('[REDACTED]');
  expect(JSON.stringify(tracker.getRecords())).not.toContain('private data');
});

describe('blocked free text', () => {
  it.each(['extract', 'classify'] as const)('blocks %s before provider work', async (operation) => {
    const complete = vi.fn();
    const service = createAIService(
      singleProviderConfig({ name: 'local', complete } as unknown as AIProviderAdapter, {
        security: {
          mode: 'block',
          entities: [
            {
              name: 'Text',
              fields: { text: { type: 'string', options: { classification: 'highly_sensitive' } } },
            },
          ],
        },
      }),
    );
    const promise =
      operation === 'extract'
        ? service.extract({ text: 'secret', schema: z.object({}) })
        : service.classify({ text: 'secret', labels: ['ok'] });
    await expect(promise).rejects.toThrow('AI security');
    expect(complete).not.toHaveBeenCalled();
  });
});
