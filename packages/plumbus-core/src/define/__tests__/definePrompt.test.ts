import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../definePrompt.js';

describe('definePrompt', () => {
  const validConfig = () => ({
    name: 'summarizeTicket',
    input: z.object({ ticketText: z.string() }),
    output: z.object({ summary: z.string(), priority: z.enum(['low', 'medium', 'high']) }),
  });

  it('creates a valid prompt definition', () => {
    const prompt = definePrompt(validConfig());
    expect(prompt.name).toBe('summarizeTicket');
  });

  it('freezes the returned definition', () => {
    const prompt = definePrompt(validConfig());
    expect(Object.isFrozen(prompt)).toBe(true);
  });

  it('accepts optional fields', () => {
    const prompt = definePrompt({
      ...validConfig(),
      system: 'You summarize support tickets.',
      description: 'Summarizes support tickets',
      domain: 'support',
      tags: ['ai'],
      owner: 'team-support',
      model: { provider: 'openai', name: 'gpt-4', temperature: 0.3, maxTokens: 500 },
    });
    expect(prompt.system).toBe('You summarize support tickets.');
    expect(prompt.model?.provider).toBe('openai');
    expect(prompt.model?.temperature).toBe(0.3);
  });

  it('throws if name is missing', () => {
    expect(() => definePrompt({ ...validConfig(), name: '' })).toThrow('name is required');
  });

  it('throws if input is not a Zod schema', () => {
    expect(() => definePrompt({ ...validConfig(), input: 'text' as any })).toThrow(
      'input must be a Zod schema',
    );
  });

  it('throws if output is not a Zod schema', () => {
    expect(() => definePrompt({ ...validConfig(), output: 42 as any })).toThrow(
      'output must be a Zod schema',
    );
  });

  it('accepts skipStreamValidationFallback and exposes it on the definition', () => {
    const prompt = definePrompt({ ...validConfig(), skipStreamValidationFallback: true });
    expect(prompt.skipStreamValidationFallback).toBe(true);
  });

  it('accepts disableTextModeBrevityHint and exposes it on the definition', () => {
    const prompt = definePrompt({ ...validConfig(), disableTextModeBrevityHint: true });
    expect(prompt.disableTextModeBrevityHint).toBe(true);
  });

  it('accepts appendUnsubstitutedInput and exposes it on the definition', () => {
    const prompt = definePrompt({ ...validConfig(), appendUnsubstitutedInput: false });
    expect(prompt.appendUnsubstitutedInput).toBe(false);
  });

  it('accepts disableStrictStructuredOutputs and exposes it on the definition', () => {
    const prompt = definePrompt({ ...validConfig(), disableStrictStructuredOutputs: true });
    expect(prompt.disableStrictStructuredOutputs).toBe(true);
  });

  it('accepts requireStrictStructuredOutputs and exposes it on the definition', () => {
    const prompt = definePrompt({ ...validConfig(), requireStrictStructuredOutputs: true });
    expect(prompt.requireStrictStructuredOutputs).toBe(true);
  });

  it('rejects conflicting strict structured output flags', () => {
    expect(() =>
      definePrompt({
        ...validConfig(),
        disableStrictStructuredOutputs: true,
        requireStrictStructuredOutputs: true,
      }),
    ).toThrow('cannot both disable and require strict structured outputs');
  });

  it('leaves optional behavior flags undefined when not provided (preserves existing defaults)', () => {
    const prompt = definePrompt(validConfig());
    expect(prompt.skipStreamValidationFallback).toBeUndefined();
    expect(prompt.disableTextModeBrevityHint).toBeUndefined();
    expect(prompt.appendUnsubstitutedInput).toBeUndefined();
    expect(prompt.disableStrictStructuredOutputs).toBeUndefined();
    expect(prompt.requireStrictStructuredOutputs).toBeUndefined();
  });
});
