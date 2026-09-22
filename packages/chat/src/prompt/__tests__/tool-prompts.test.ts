import { describe, expect, it } from 'vitest';
import { chatScopeCheckPrompt } from '../chat-scope-check.prompt.js';
import { chatToolRoundPrompt } from '../chat-tool-round.prompt.js';

describe('tool-calling prompts', () => {
  it('chat.scopeCheck has temperature 0 and maxTokens 64', () => {
    expect(chatScopeCheckPrompt.model).toEqual({ temperature: 0, maxTokens: 64 });
  });

  it('chat.toolRound disables strict structured outputs', () => {
    expect(chatToolRoundPrompt.disableStrictStructuredOutputs).toBe(true);
    expect(chatToolRoundPrompt.name).toBe('chat.toolRound');
  });
});
