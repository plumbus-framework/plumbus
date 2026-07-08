import { describe, expect, it } from '@plumbus/core/testing';
import { buildSystemPrompt } from '../build-system-prompt.js';

describe('buildSystemPrompt', () => {
  it('includes identity and citation contract', () => {
    const prompt = buildSystemPrompt({
      chatInstructions: 'You are a helper.',
      audience: 'user',
      locale: 'en',
      resolvedContext: { items: [], sources: [], estimatedTokens: 0 },
      allowedSourceHandles: ['src_a1'],
    });
    expect(prompt).toContain('You are a helper.');
    expect(prompt).toContain('src_a1');
    expect(prompt).toContain("Reply in 'en' only");
  });

  it('C9: replyLocale override forces anchor language', () => {
    const prompt = buildSystemPrompt({
      chatInstructions: 'Helper',
      audience: 'user',
      locale: 'en',
      replyLocale: 'he',
      resolvedContext: { items: [], sources: [], estimatedTokens: 0 },
      allowedSourceHandles: [],
    });
    expect(prompt).toContain("Reply in 'he' only");
  });
});
