import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import { PromptRegistry } from '../prompt-registry.js';

describe('PromptRegistry', () => {
  function makePrompt(name: string, domain?: string) {
    return definePrompt({
      name,
      domain,
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
    });
  }

  it('registers and retrieves a prompt', () => {
    const registry = new PromptRegistry();
    const prompt = makePrompt('summarize');
    registry.register(prompt);

    expect(registry.get('summarize')).toBe(prompt);
  });

  it('throws on duplicate registration', () => {
    const registry = new PromptRegistry();
    registry.register(makePrompt('summarize'));

    expect(() => registry.register(makePrompt('summarize'))).toThrow(
      'Prompt "summarize" is already registered',
    );
  });

  it('throws on missing prompt', () => {
    const registry = new PromptRegistry();
    expect(() => registry.get('missing')).toThrow('Prompt "missing" not found');
  });

  it('checks existence with has()', () => {
    const registry = new PromptRegistry();
    registry.register(makePrompt('classify'));

    expect(registry.has('classify')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('returns all prompts', () => {
    const registry = new PromptRegistry();
    registry.register(makePrompt('a'));
    registry.register(makePrompt('b'));

    expect(registry.getAll()).toHaveLength(2);
  });

  it('filters by domain', () => {
    const registry = new PromptRegistry();
    registry.register(makePrompt('a', 'billing'));
    registry.register(makePrompt('b', 'support'));
    registry.register(makePrompt('c', 'billing'));

    const billing = registry.getByDomain('billing');
    expect(billing).toHaveLength(2);
    expect(billing.map((p) => p.name)).toEqual(['a', 'c']);
  });

  it('returns empty array when discovering from non-existent directory', async () => {
    const registry = new PromptRegistry();
    const found = await registry.discoverPrompts('/tmp/plumbus-nonexistent-' + Date.now());
    expect(found).toEqual([]);
  });
});
