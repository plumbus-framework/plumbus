export type TranscriptSource = 'server-stt' | 'client-stt';

export interface TranscriptTrustInput {
  text: string;
  source?: TranscriptSource;
  language?: string;
}

export interface TranscriptTrustPolicy {
  maxChars?: number;
}

export interface TrustedTranscript {
  ok: boolean;
  text: string;
  source: TranscriptSource;
  authoritative: boolean;
  billable: boolean;
  language?: string;
  reason?: string;
}

const DEFAULT_MAX_CHARS = 4000;

export function assessTranscriptTrust(
  input: TranscriptTrustInput,
  policy: TranscriptTrustPolicy = {},
): TrustedTranscript {
  const text = input.text.trim();
  const source = input.source ?? 'server-stt';

  if (!text) {
    return {
      ok: false,
      text,
      source,
      authoritative: source === 'server-stt',
      billable: source === 'server-stt',
      language: input.language,
      reason: 'Transcript is empty',
    };
  }

  const maxChars = policy.maxChars ?? DEFAULT_MAX_CHARS;
  if (text.length > maxChars) {
    return {
      ok: false,
      text,
      source,
      authoritative: source === 'server-stt',
      billable: false,
      language: input.language,
      reason: `Transcript exceeds ${maxChars} characters`,
    };
  }

  return {
    ok: true,
    text,
    source,
    authoritative: source === 'server-stt',
    billable: source === 'server-stt',
    language: input.language,
  };
}
