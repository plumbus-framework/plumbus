import { describe, expect, it } from 'vitest';
import {
  base64Length,
  contentHasImages,
  contentText,
  describeImage,
  estimateAnthropicImageTokens,
  estimateOpenAIImageTokens,
  estimateUnscaledImageTokens,
  imageToBase64,
  imageToDataUrl,
} from '../image-input.js';
import { AIInvalidRequestError } from '../refusal.js';
import { blankPng, jpegHeader, webpHeader } from './image-fixtures.js';

function reasonOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AIInvalidRequestError ? error.reason : `other:${String(error)}`;
  }
  return undefined;
}

describe('describeImage', () => {
  it('reads PNG, JPEG and WebP sizes from their headers', () => {
    expect(describeImage({ mediaType: 'image/png', data: blankPng(40, 30) })).toMatchObject({
      mediaType: 'image/png',
      width: 40,
      height: 30,
    });
    expect(describeImage({ mediaType: 'image/jpeg', data: jpegHeader(1600, 2070) })).toMatchObject({
      width: 1600,
      height: 2070,
    });
    expect(describeImage({ mediaType: 'image/webp', data: webpHeader(800, 600) })).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it('refuses a declared media type the bytes do not match', () => {
    expect(reasonOf(() => describeImage({ mediaType: 'image/jpeg', data: blankPng(2, 2) }))).toBe(
      'image_media_type_mismatch',
    );
    expect(
      reasonOf(() => describeImage({ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) })),
    ).toBe('image_media_type_mismatch');
  });

  it('refuses unsupported media types, empty bytes and non-byte data', () => {
    expect(
      reasonOf(() =>
        describeImage({ mediaType: 'image/gif' as 'image/png', data: blankPng(2, 2) }),
      ),
    ).toBe('image_media_type_unsupported');
    expect(reasonOf(() => describeImage({ mediaType: 'image/png', data: new Uint8Array() }))).toBe(
      'image_data_invalid',
    );
    expect(
      reasonOf(() =>
        describeImage({ mediaType: 'image/png', data: 'iVBORw0KGgo=' as unknown as Uint8Array }),
      ),
    ).toBe('image_data_invalid');
  });

  it('refuses a header without a readable size', () => {
    const truncated = blankPng(4, 4).subarray(0, 16);
    expect(reasonOf(() => describeImage({ mediaType: 'image/png', data: truncated }))).toBe(
      'image_unreadable',
    );
  });
});

describe('encoding helpers', () => {
  it('base64 and data URLs encode the bytes, honouring the view offset', () => {
    const backing = new Uint8Array([0, 0, 1, 2, 3, 0]);
    const view = backing.subarray(2, 5);
    expect(imageToBase64({ mediaType: 'image/png', data: view })).toBe('AQID');
    expect(imageToDataUrl({ mediaType: 'image/png', data: view })).toBe(
      'data:image/png;base64,AQID',
    );
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
  });

  it('reads text and image presence of a user turn', () => {
    const parts = [
      { type: 'image' as const, mediaType: 'image/png' as const, data: blankPng(1, 1) },
      { type: 'text' as const, text: 'a' },
      { type: 'text' as const, text: 'b' },
    ];
    expect(contentHasImages(parts)).toBe(true);
    expect(contentHasImages('text')).toBe(false);
    expect(contentText(parts)).toBe('a\n\nb');
  });
});

describe('image token rules', () => {
  it('OpenAI: 85 + 170 per 512 px tile after fitting 2048 and a 768 px shortest side', () => {
    // 1024×1024 → 768×768 → 4 tiles.
    expect(estimateOpenAIImageTokens(1024, 1024)).toBe(85 + 170 * 4);
    // 2048×4096 → 1024×2048 → 768×1536 → 2×3 tiles.
    expect(estimateOpenAIImageTokens(2048, 4096)).toBe(85 + 170 * 6);
    // Small images are not scaled up.
    expect(estimateOpenAIImageTokens(256, 256)).toBe(85 + 170);
    // A 1600×2070 page render → 768×993.6 → 2×2 tiles.
    expect(estimateOpenAIImageTokens(1600, 2070)).toBe(85 + 170 * 4);
  });

  it('Anthropic: width × height / 750 after scaling to 1568 px and about 1600 tokens', () => {
    expect(estimateAnthropicImageTokens(200, 200)).toBe(Math.ceil((200 * 200) / 750));
    // Large images are capped near 1600 tokens.
    expect(estimateAnthropicImageTokens(1600, 2070)).toBeLessThanOrEqual(1600);
    expect(estimateAnthropicImageTokens(1600, 2070)).toBeGreaterThan(1500);
    expect(estimateAnthropicImageTokens(4000, 100)).toBe(Math.ceil((1568 * 39.2) / 750));
  });

  it('fallback: width × height / 750 at full size', () => {
    expect(estimateUnscaledImageTokens(1500, 1500)).toBe(3000);
  });
});
