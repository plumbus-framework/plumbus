import { createAIService, singleProviderConfig } from '@plumbus/core/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createBedrockAdapter, estimateBedrockImageTokens } from '../bedrock-adapter.js';
import type { BedrockPricingStore } from '../pricing.js';

/** PNG signature + IHDR (all core reads; Converse receives the bytes untouched). */
function blankPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function pricing(): BedrockPricingStore {
  return {
    warm: vi.fn().mockResolvedValue(undefined),
    getRate: vi.fn().mockReturnValue({ inputPerMTok: 3, outputPerMTok: 15, kind: 'text' as const }),
    listRates: vi.fn().mockReturnValue([]),
    calculateCost: vi.fn().mockReturnValue(0.01),
  };
}

const converseAnswer = {
  output: { message: { role: 'assistant', content: [{ text: '{"ok":true}' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 1580, outputTokens: 4, totalTokens: 1584 },
};

function adapterWith(send: ReturnType<typeof vi.fn>) {
  return createBedrockAdapter({
    region: 'us-east-1',
    pricingStore: pricing(),
    runtimeClient: { send } as never,
    warmPricingOnCreate: false,
  });
}

function commandInput(send: ReturnType<typeof vi.fn>): Record<string, any> {
  return (send.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
}

const png = { mediaType: 'image/png' as const, data: blankPng(6, 4) };

describe('Bedrock Converse image input', () => {
  it('declares image input with Converse limits', () => {
    const adapter = adapterWith(vi.fn());
    expect(adapter.capabilities?.imageInput).toBe(true);
    expect(adapter.capabilities?.imageInputLimits).toEqual({
      maxImages: 20,
      maxImageBytes: 3_750_000,
    });
  });

  it('sends images as image.format + source.bytes before the prompt text', async () => {
    const send = vi.fn().mockResolvedValue(converseAnswer);
    const result = await adapterWith(send).complete({
      prompt: 'page text',
      model: 'anthropic.claude-sonnet-5-5',
      images: [png, { mediaType: 'image/webp', data: new Uint8Array([1]) }],
    });
    const content = commandInput(send).messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ image: { format: 'png', source: { bytes: png.data } } });
    expect(content[0].image.source.bytes).toBeInstanceOf(Uint8Array);
    expect(content[1].image.format).toBe('webp');
    expect(content[2]).toEqual({ text: 'page text' });
    // Usage comes from Converse, unchanged.
    expect(result.usage.inputTokens).toBe(1580);
  });

  it('an image-only turn sends no empty text block', async () => {
    const send = vi.fn().mockResolvedValue(converseAnswer);
    await adapterWith(send).complete({ prompt: '', images: [png] });
    expect(commandInput(send).messages[0].content).toEqual([
      { image: { format: 'png', source: { bytes: png.data } } },
    ]);
  });

  it('maps image parts of user turns (jpeg) in order', async () => {
    const send = vi.fn().mockResolvedValue(converseAnswer);
    await adapterWith(send).complete({
      prompt: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at' },
            { type: 'image', mediaType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8]) },
          ],
        },
      ],
    });
    expect(commandInput(send).messages[0].content).toEqual([
      { text: 'look at' },
      { image: { format: 'jpeg', source: { bytes: new Uint8Array([0xff, 0xd8]) } } },
    ]);
  });

  it('stream sends the same image blocks', async () => {
    async function* events() {
      yield { messageStop: { stopReason: 'end_turn' } };
    }
    const send = vi.fn().mockResolvedValue({ stream: events() });
    for await (const _event of adapterWith(send).stream({ prompt: 'x', images: [png] })) {
      // drain
    }
    expect(commandInput(send).messages[0].content[0]).toEqual({
      image: { format: 'png', source: { bytes: png.data } },
    });
  });

  it('estimates Claude images by the Anthropic rule and other models at full size', () => {
    const image = { mediaType: 'image/png' as const, width: 1600, height: 2070, byteLength: 1 };
    expect(estimateBedrockImageTokens(image, 'anthropic.claude-sonnet-5-5')).toBeLessThanOrEqual(
      1600,
    );
    expect(estimateBedrockImageTokens(image, 'us.anthropic.claude-sonnet-5-5')).toBeLessThanOrEqual(
      1600,
    );
    expect(estimateBedrockImageTokens(image, 'amazon.nova-pro-v1:0')).toBe(
      Math.ceil((1600 * 2070) / 750),
    );
  });

  it('through core: images over 3.75 MB are refused before Converse is called', async () => {
    const send = vi.fn().mockResolvedValue(converseAnswer);
    const service = createAIService(singleProviderConfig(adapterWith(send)));
    const big = new Uint8Array(3_800_000);
    big.set(blankPng(2, 2));
    await expect(
      service.generate({ prompt: 'x', input: {}, images: [{ mediaType: 'image/png', data: big }] }),
    ).rejects.toMatchObject({ name: 'AIInvalidRequestError', reason: 'image_too_large' });
    expect(send).not.toHaveBeenCalled();
  });
});
