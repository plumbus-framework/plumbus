// ── AI image input ──
// Image content parts for `ctx.ai` model calls: the shared types, the structural checks every
// image passes before a provider sees it (declared media type matches the bytes, dimensions
// readable from the header), and each built-in provider's published image-token rule, used only
// for the pre-call budget estimate. The ledger records the tokens the provider reports.

import { AIInvalidRequestError } from './refusal.js';

/** Media types an image content part may carry. */
export const AIImageMediaType = {
  Png: 'image/png',
  Jpeg: 'image/jpeg',
  Webp: 'image/webp',
} as const;

export type AIImageMediaType = (typeof AIImageMediaType)[keyof typeof AIImageMediaType];

/** One image given to a model: its media type and its encoded bytes (not base64). */
export interface AIImageInput {
  mediaType: AIImageMediaType;
  data: Uint8Array;
}

/** A text part of a user turn. */
export interface AITextContentPart {
  type: 'text';
  text: string;
}

/** An image part of a user turn. */
export interface AIImageContentPart extends AIImageInput {
  type: 'image';
}

/** One part of a user turn whose content is not a plain string. */
export type ContentPart = AITextContentPart | AIImageContentPart;

/** An image whose header has been read: what the size guard and the token estimate need. */
export interface AIImageDescriptor {
  mediaType: AIImageMediaType;
  width: number;
  height: number;
  /** Encoded size in bytes (what is sent, before base64). */
  byteLength: number;
}

/**
 * Wire limits a provider declares for image input. Every field is optional; an omitted one is
 * not checked by the AI service.
 */
export interface AIImageInputLimits {
  /** Largest encoded image, in bytes. */
  maxImageBytes?: number;
  /** Most images in one request. */
  maxImages?: number;
  /** Largest request body, in bytes, with every image counted base64-encoded. */
  maxRequestBytes?: number;
}

/** Built-in adapters' declared limits (from each provider's published image-input limits). */
export const OPENAI_IMAGE_INPUT_LIMITS: Readonly<AIImageInputLimits> = Object.freeze({
  maxImages: 500,
  maxRequestBytes: 50 * 1024 * 1024,
});
export const ANTHROPIC_IMAGE_INPUT_LIMITS: Readonly<AIImageInputLimits> = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImages: 100,
  maxRequestBytes: 32 * 1024 * 1024,
});

const MEDIA_TYPES = new Set<string>(Object.values(AIImageMediaType));

function invalidImage(reason: string, message: string): AIInvalidRequestError {
  return new AIInvalidRequestError({ reason, message });
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

/** The media type the bytes' signature names, or undefined when it is none of the three. */
function sniffMediaType(bytes: Uint8Array): AIImageMediaType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return AIImageMediaType.Png;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return AIImageMediaType.Jpeg;
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return AIImageMediaType.Webp;
  return undefined;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  // Signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
  if (bytes.length < 24 || !startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return undefined;
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Markers without a length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return undefined;
    // Start-of-frame markers (baseline, progressive, lossless, arithmetic), not DHT/JPG/DAC.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: readUint16BE(bytes, offset + 5), width: readUint16BE(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (chunk === 'VP8 ') {
    // Frame tag (3), start code 9d 01 2a (3), then 14-bit width and height.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
    return {
      width: (bytes[26] ?? 0) + (((bytes[27] ?? 0) & 0x3f) << 8),
      height: (bytes[28] ?? 0) + (((bytes[29] ?? 0) & 0x3f) << 8),
    };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + readUint24LE(bytes, 24), height: 1 + readUint24LE(bytes, 27) };
  }
  return undefined;
}

/**
 * Check one image and read its dimensions. Refuses (with `AIInvalidRequestError`) a media type
 * other than PNG, JPEG or WebP, bytes that are not a `Uint8Array`, an empty image, bytes whose
 * signature names a different format than the declared `mediaType`, and a header whose size
 * cannot be read. Never decodes pixel data.
 */
export function describeImage(image: AIImageInput, label = 'image'): AIImageDescriptor {
  if (!MEDIA_TYPES.has(image.mediaType)) {
    throw invalidImage(
      'image_media_type_unsupported',
      `${label}: mediaType must be image/png, image/jpeg or image/webp`,
    );
  }
  if (!(image.data instanceof Uint8Array)) {
    throw invalidImage('image_data_invalid', `${label}: data must be a Uint8Array of image bytes`);
  }
  if (image.data.byteLength === 0) {
    throw invalidImage('image_data_invalid', `${label}: data is empty`);
  }
  const sniffed = sniffMediaType(image.data);
  if (sniffed !== image.mediaType) {
    throw invalidImage(
      'image_media_type_mismatch',
      `${label}: declared ${image.mediaType} but the bytes are ${sniffed ?? 'not a PNG, JPEG or WebP image'}`,
    );
  }
  const size =
    sniffed === AIImageMediaType.Png
      ? pngSize(image.data)
      : sniffed === AIImageMediaType.Jpeg
        ? jpegSize(image.data)
        : webpSize(image.data);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw invalidImage('image_unreadable', `${label}: the image header has no readable size`);
  }
  return {
    mediaType: image.mediaType,
    width: size.width,
    height: size.height,
    byteLength: image.data.byteLength,
  };
}

/** Base64 of the image bytes. */
export function imageToBase64(image: AIImageInput): string {
  return Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString(
    'base64',
  );
}

/** `data:` URL of the image (OpenAI `image_url` / `input_image`). */
export function imageToDataUrl(image: AIImageInput): string {
  return `data:${image.mediaType};base64,${imageToBase64(image)}`;
}

/** Length of the base64 encoding of `byteLength` bytes. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** True when a user turn's content carries at least one image part. */
export function contentHasImages(content: string | readonly ContentPart[]): boolean {
  return typeof content !== 'string' && content.some((part) => part.type === 'image');
}

/** Text of a user turn's content: the string itself, or its text parts joined by blank lines. */
export function contentText(content: string | readonly ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is AITextContentPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

// ── Image token rules (pre-call estimate only) ──

/**
 * OpenAI's tile rule at `detail: "high"` (the most a request without `detail` can cost): the image
 * is fitted inside 2048×2048, then scaled so its shortest side is at most 768 px, and costs 85
 * tokens plus 170 per 512 px tile.
 */
export function estimateOpenAIImageTokens(width: number, height: number): number {
  let w = width;
  let h = height;
  const fit = Math.min(1, 2048 / Math.max(w, h));
  w *= fit;
  h *= fit;
  const shortest = Math.min(w, h);
  if (shortest > 768) {
    const scale = 768 / shortest;
    w *= scale;
    h *= scale;
  }
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return 85 + 170 * tiles;
}

/**
 * Anthropic's rule: an image whose long edge is over 1568 px, or that would cost over about 1600
 * tokens, is first scaled down (aspect kept); it then costs width × height / 750 tokens.
 */
export function estimateAnthropicImageTokens(width: number, height: number): number {
  const scale = Math.min(
    1,
    1568 / Math.max(width, height),
    Math.sqrt((1600 * 750) / (width * height)),
  );
  return Math.ceil((width * scale * (height * scale)) / 750);
}

/**
 * Fallback for an adapter that accepts images but declares no rule of its own: width × height /
 * 750 tokens at the image's full size, with no downscaling (an upper bound for the common rules).
 */
export function estimateUnscaledImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}
