import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/index.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { PromptRegistry } from '../prompt-registry.js';
import type { AIProviderAdapter } from '../provider.js';

it('does not re-expand placeholders or replacement metacharacters from supplied values', async () => {
  const complete = vi.fn(async () => ({
    content: 'ok',
    model: 'local',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }));
  const registry = new PromptRegistry();
  registry.register(
    definePrompt({
      name: 'template',
      domain: 'test',
      system: '{{context}}',
      description: '{{message}}',
      input: z.object({ context: z.string(), message: z.string() }),
      output: z.string(),
      appendUnsubstitutedInput: false,
    }),
  );
  const service = createAIService(
    singleProviderConfig({ name: 'local', complete } as unknown as AIProviderAdapter, {
      promptRegistry: registry,
    }),
  );
  await service.generate({
    prompt: 'template',
    input: { context: '{{message}} $&', message: 'private user message' },
  });
  expect(complete.mock.calls[0]?.[0]).toMatchObject({
    system: '{{message}} $&',
    prompt: 'private user message',
  });
});
