/** Metadata keys safe to expose in HTTP/SSE error responses. */
export const SAFE_ERROR_METADATA_KEYS = [
  'field',
  'httpStatus',
  'retryAfter',
  'hint',
  'docUrl',
  'reason',
  'executionId',
] as const;

export type SafeErrorMetadataKey = (typeof SAFE_ERROR_METADATA_KEYS)[number];

export function pickSafeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const safe: Record<string, unknown> = {};
  for (const key of SAFE_ERROR_METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}
