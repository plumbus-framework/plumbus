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
      description: 'Summarizes support tickets',
      domain: 'support',
      tags: ['ai'],
      owner: 'team-support',
      model: { provider: 'openai', name: 'gpt-4', temperature: 0.3, maxTokens: 500 },
    });
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
});
