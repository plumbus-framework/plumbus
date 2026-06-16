import { describe, expect, it } from 'vitest';
import { assessTranscriptTrust } from '../transcript-trust.js';

describe('assessTranscriptTrust', () => {
  it('rejects empty transcripts', () => {
    const result = assessTranscriptTrust({ text: '   ', source: 'server-stt' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('marks server STT as authoritative and billable', () => {
    const result = assessTranscriptTrust({ text: 'hello world', source: 'server-stt' });
    expect(result.ok).toBe(true);
    expect(result.authoritative).toBe(true);
    expect(result.billable).toBe(true);
  });

  it('marks client STT as non-authoritative and non-billable', () => {
    const result = assessTranscriptTrust({ text: 'browser transcript', source: 'client-stt' });
    expect(result.ok).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.billable).toBe(false);
  });

  it('rejects transcripts above the configured character cap', () => {
    const result = assessTranscriptTrust(
      { text: 'x'.repeat(50), source: 'server-stt' },
      { maxChars: 10 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exceeds');
  });
});
