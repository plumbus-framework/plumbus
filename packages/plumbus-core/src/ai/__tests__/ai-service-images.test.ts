import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mockAIProvider } from '../../testing/mock-providers.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import type { AICostRecord } from '../cost-tracker.js';
import { createCostTracker } from '../cost-tracker.js';
import { AIImageInputUnsupportedError, AIInvalidRequestError } from '../refusal.js';
import { blankPng, jpegHeader } from './image-fixtures.js';

const page = { mediaType: 'image/png' as const, data: blankPng(16, 20) };

async function reasonOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AIInvalidRequestError) return error.reason;
    if (error instanceof AIImageInputUnsupportedError) return 'unsupported';
    return `other:${error instanceof Error ? error.message : String(error)}`;
  }
  return 'resolved';
}

describe('ctx.ai image input', () => {
  it('advertises features.imageInput', () => {
    const service = createAIService(singleProviderConfig(mockAIProvider()));
    expect(service.features?.imageInput).toBe(true);
  });

  it('generate: images travel on the request beside the prompt', async () => {
    const provider = mockAIProvider({ respond: 'seen' });
    const service = createAIService(singleProviderConfig(provider));
    await service.generate({ prompt: 'Describe the page', input: {}, images: [page] });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.images).toEqual([page]);
    expect(provider.requests[0]?.prompt).toContain('Describe the page');
  });

  it('generateWithUsage with messages: images join the last user turn, caller array untouched', async () => {
    const provider = mockAIProvider({ respond: 'seen' });
    const service = createAIService(singleProviderConfig(provider));
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'user' as const, content: 'read this page' },
    ];
    await service.generateWithUsage({
      prompt: 'chat',
      input: {},
      messages,
      images: [page],
      outputValidation: 'none',
    });
    const sent = provider.requests[0];
    expect(sent?.images).toBeUndefined();
    expect(sent?.messages?.[2]).toEqual({
      role: 'user',
      content: [
        { type: 'image', ...page },
        { type: 'text', text: 'read this page' },
      ],
    });
    expect(messages[2]?.content).toBe('read this page');
    expect(provider.hadImages()).toBe(true);
  });

  it('refuses images when the last message is not a user turn', async () => {
    const service = createAIService(singleProviderConfig(mockAIProvider()));
    expect(
      await reasonOf(() =>
        service.generate({
          prompt: 'x',
          input: {},
          messages: [{ role: 'assistant', content: 'done' }],
          images: [page],
        }),
      ),
    ).toBe('images_need_user_turn');
  });

  it('a provider without imageInput refuses with a typed error and is never called', async () => {
    const provider = mockAIProvider({ capabilities: { imageInput: false } });
    const service = createAIService(singleProviderConfig(provider));
    await expect(
      service.generate({ prompt: 'x', input: {}, images: [page] }),
    ).rejects.toBeInstanceOf(AIImageInputUnsupportedError);
    await expect(
      service.extract({ schema: z.object({ a: z.string() }), text: '', images: [page] }),
    ).rejects.toMatchObject({ name: 'AIImageInputUnsupportedError', provider: 'mock' });
    expect(provider.requests).toHaveLength(0);
  });

  it('an adapter that declares no capabilities refuses images too (never drops them)', async () => {
    const provider = mockAIProvider();
    const legacy = { ...provider, capabilities: undefined };
    const service = createAIService(singleProviderConfig(legacy));
    expect(await reasonOf(() => service.generate({ prompt: 'x', input: {}, images: [page] }))).toBe(
      'unsupported',
    );
    // Text-only calls are unaffected.
    await expect(service.generate({ prompt: 'x', input: {} })).resolves.toBeDefined();
  });

  it('refuses image parts in caller-built messages for a provider without imageInput', async () => {
    const provider = mockAIProvider({ capabilities: { imageInput: false } });
    const service = createAIService(singleProviderConfig(provider));
    expect(
      await reasonOf(() =>
        service.generate({
          prompt: 'x',
          input: {},
          messages: [{ role: 'user', content: [{ type: 'image', ...page }] }],
        }),
      ),
    ).toBe('unsupported');
  });

  it('checks each image against its declared media type before sending', async () => {
    const provider = mockAIProvider();
    const service = createAIService(singleProviderConfig(provider));
    expect(
      await reasonOf(() =>
        service.generate({
          prompt: 'x',
          input: {},
          images: [{ mediaType: 'image/jpeg', data: blankPng(2, 2) }],
        }),
      ),
    ).toBe('image_media_type_mismatch');
    expect(provider.requests).toHaveLength(0);
  });

  describe('request-size guard', () => {
    it('refuses an image over the provider maxImageBytes', async () => {
      const provider = mockAIProvider({
        capabilities: { imageInputLimits: { maxImageBytes: 100 } },
      });
      const service = createAIService(singleProviderConfig(provider));
      const big = { mediaType: 'image/png' as const, data: blankPng(400, 400) };
      expect(big.data.byteLength).toBeGreaterThan(100);
      expect(
        await reasonOf(() => service.generate({ prompt: 'x', input: {}, images: [big] })),
      ).toBe('image_too_large');
      expect(provider.requests).toHaveLength(0);
    });

    it('refuses more images than the provider maxImages', async () => {
      const provider = mockAIProvider({ capabilities: { imageInputLimits: { maxImages: 1 } } });
      const service = createAIService(singleProviderConfig(provider));
      expect(
        await reasonOf(() => service.generate({ prompt: 'x', input: {}, images: [page, page] })),
      ).toBe('too_many_images');
    });

    it('counts image bytes base64-encoded against maxRequestBytes', async () => {
      const image = { mediaType: 'image/png' as const, data: blankPng(300, 300) };
      const encoded = Math.ceil(image.data.byteLength / 3) * 4;
      const tight = mockAIProvider({
        capabilities: { imageInputLimits: { maxRequestBytes: encoded } },
      });
      expect(
        await reasonOf(() =>
          createAIService(singleProviderConfig(tight)).generate({
            prompt: 'x',
            input: {},
            images: [image],
          }),
        ),
      ).toBe('request_too_large');
      const roomy = mockAIProvider({
        capabilities: { imageInputLimits: { maxRequestBytes: encoded + 4096 } },
      });
      await expect(
        createAIService(singleProviderConfig(roomy)).generate({
          prompt: 'x',
          input: {},
          images: [image],
        }),
      ).resolves.toBeDefined();
    });

    it('prices images by the provider rule in the per-request token budget', async () => {
      // 1500×1500 at width × height / 750 = 3000 estimated tokens (mock rule), not the bytes.
      const image = { mediaType: 'image/jpeg' as const, data: jpegHeader(1500, 1500) };
      const over = createAIService(
        singleProviderConfig(mockAIProvider(), {
          costTracker: createCostTracker({ maxTokensPerRequest: 2500 }),
        }),
      );
      await expect(
        over.generate({ prompt: 'x', input: {}, images: [image] }),
      ).rejects.toMatchObject({ name: 'AIBudgetExceededError' });
      const within = createAIService(
        singleProviderConfig(mockAIProvider(), {
          costTracker: createCostTracker({ maxTokensPerRequest: 3500 }),
        }),
      );
      await expect(
        within.generate({ prompt: 'x', input: {}, images: [image] }),
      ).resolves.toBeDefined();
    });

    it('does not count image bytes as text', async () => {
      // A ~1 MB-on-the-wire image would be ~350 000 "text tokens"; the image rule prices it small.
      const bulky = new Uint8Array(1_000_000);
      bulky.set(jpegHeader(32, 32));
      const service = createAIService(
        singleProviderConfig(mockAIProvider(), {
          costTracker: createCostTracker({ maxTokensPerRequest: 1000 }),
        }),
      );
      await expect(
        service.generate({
          prompt: 'x',
          input: {},
          images: [{ mediaType: 'image/jpeg', data: bulky }],
        }),
      ).resolves.toBeDefined();
    });

    it('uses the adapter rule, falling back to width × height / 750', async () => {
      const image = { mediaType: 'image/jpeg' as const, data: jpegHeader(1500, 1500) };
      const cheap = { ...mockAIProvider(), estimateImageInputTokens: () => 10 };
      const service = createAIService(
        singleProviderConfig(cheap, {
          costTracker: createCostTracker({ maxTokensPerRequest: 200 }),
        }),
      );
      await expect(
        service.generate({ prompt: 'x', input: {}, images: [image] }),
      ).resolves.toBeDefined();
      const noRule = { ...mockAIProvider(), estimateImageInputTokens: undefined };
      const strict = createAIService(
        singleProviderConfig(noRule, {
          costTracker: createCostTracker({ maxTokensPerRequest: 2500 }),
        }),
      );
      await expect(
        strict.generate({ prompt: 'x', input: {}, images: [image] }),
      ).rejects.toMatchObject({ name: 'AIBudgetExceededError' });
    });
  });

  it('records the provider-reported tokens in the ledger', async () => {
    const rows: AICostRecord[] = [];
    const provider = mockAIProvider({
      respond: 'ok',
      usage: { inputTokens: 1234, outputTokens: 7 },
    });
    const service = createAIService(
      singleProviderConfig(provider, { onAICostRecorded: (row) => void rows.push(row) }),
    );
    await service.generate({ prompt: 'x', input: {}, images: [page] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usage).toMatchObject({ inputTokens: 1234, outputTokens: 7 });
    expect(rows[0]?.status).toBe('success');
  });

  it('extract: sends images with the text and the caller prompt as instructions', async () => {
    const provider = mockAIProvider({ respond: { title: 'Sets' } });
    const service = createAIService(singleProviderConfig(provider));
    const result = await service.extract({
      schema: z.object({ title: z.string() }),
      prompt: 'Read the IMAGE; the text may have lost symbols.',
      text: 'extracted page text',
      images: [page],
    });
    expect(result).toEqual({ title: 'Sets' });
    const sent = provider.requests[0];
    expect(sent?.images).toEqual([page]);
    expect(sent?.prompt).toContain('extracted page text');
    expect(sent?.system).toContain('images and text');
    expect(sent?.system).toContain('Read the IMAGE; the text may have lost symbols.');
  });

  it('extract without prompt or images keeps the text-only instruction', async () => {
    const provider = mockAIProvider({ respond: { title: 'x' } });
    const service = createAIService(singleProviderConfig(provider));
    await service.extract({ schema: z.object({ title: z.string() }), text: 'abc' });
    expect(provider.requests[0]?.system).toBe(
      'Extract structured data from the following text. Return valid JSON matching the required schema.',
    );
    expect(provider.requests[0]?.images).toBeUndefined();
  });

  it('extract keeps the images on validation retries', async () => {
    let calls = 0;
    const provider = mockAIProvider({
      respond: () => (++calls === 1 ? '{"title":1}' : '{"title":"ok"}'),
    });
    const service = createAIService(
      singleProviderConfig(provider, { validation: { maxRetries: 1 } }),
    );
    await service.extract({ schema: z.object({ title: z.string() }), text: '', images: [page] });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.images).toEqual([page]);
  });

  it('streamGenerate: images travel on the request', async () => {
    const provider = mockAIProvider({ respond: '{"a":1}' });
    const service = createAIService(singleProviderConfig(provider));
    for await (const _event of service.streamGenerate({ prompt: 'x', input: {}, images: [page] })) {
      // drain
    }
    expect(provider.requests[0]?.images).toEqual([page]);
  });
});
