import { describe, expect, it } from 'vitest';
import { loadPromptOverrides } from '../../config/loader.js';
import { promptOverrideEnvKey, resolvePromptOverride } from '../prompt-overrides.js';

describe('resolvePromptOverride', () => {
  it('keys env overrides by the lower-case name with dots as underscores', () => {
    expect(promptOverrideEnvKey('Report.Summarize')).toBe('report_summarize');
    expect(promptOverrideEnvKey('summarize')).toBe('summarize');
  });

  it('keeps the env fields a higher layer leaves unset', () => {
    // Shaped exactly as loadConfig builds it: unset fields are present as `undefined`.
    const env = loadPromptOverrides({
      PROMPT_REPORT_SUMMARIZE_MAX_TOKENS: '321',
      PROMPT_REPORT_SUMMARIZE_TIMEOUT_MS: '50000',
    });
    const dynamic = { report_summarize: { model: 'gpt-4.1-mini' } };

    expect(resolvePromptOverride('report.summarize', [env, dynamic])).toEqual({
      model: 'gpt-4.1-mini',
      maxTokens: 321,
      timeoutMs: 50_000,
    });
  });

  it('lets a field the higher layer sets win, but not one it sets to null or undefined', () => {
    const env = { report_summarize: { model: 'gpt-4o-mini', maxTokens: 321, temperature: 0.4 } };
    const dynamic = {
      report_summarize: {
        model: undefined,
        maxTokens: 222,
        temperature: null as unknown as number,
      },
    };

    expect(resolvePromptOverride('report.summarize', [env, dynamic])).toEqual({
      model: 'gpt-4o-mini',
      maxTokens: 222,
      temperature: 0.4,
    });
  });

  it("finds a higher layer's entry under the prompt's own name over a lower layer's env key", () => {
    const env = { report_summarize: { model: 'gpt-4o-mini' } };
    const dynamic = { 'report.summarize': { model: 'gpt-4.1-mini' } };

    expect(resolvePromptOverride('report.summarize', [env, dynamic])?.model).toBe('gpt-4.1-mini');
  });

  it("prefers the prompt's own name over its env-style key within one layer, field by field", () => {
    const layer = {
      report_summarize: { model: 'by-env-key', maxTokens: 5 },
      'report.summarize': { model: 'by-name' },
    };

    expect(resolvePromptOverride('report.summarize', [layer])).toEqual({
      model: 'by-name',
      maxTokens: 5,
    });
  });

  it('returns undefined when no layer sets anything for the prompt', () => {
    expect(resolvePromptOverride('report.summarize', [undefined, {}])).toBeUndefined();
    expect(
      resolvePromptOverride('report.summarize', [{ report_summarize: { model: undefined } }]),
    ).toBeUndefined();
    expect(resolvePromptOverride('other', [{ report_summarize: { model: 'x' } }])).toBeUndefined();
  });

  it('treats reasoning and reasoningEffort as one field: the higher layer that sets either decides both', () => {
    const lower = {
      report_summarize: {
        reasoning: { mode: 'effort' as const, effort: 'high' as const },
        maxTokens: 321,
      },
    };
    const higher = { 'report.summarize': { reasoningEffort: 'low' as const } };

    const merged = resolvePromptOverride('report.summarize', [lower, higher]);

    expect(merged?.reasoningEffort).toBe('low');
    expect(merged?.reasoning).toBeUndefined();
    expect(merged?.maxTokens).toBe(321);
    // A higher layer that sets neither keeps the lower pair.
    expect(
      resolvePromptOverride('report.summarize', [lower, { report_summarize: { model: 'm' } }])
        ?.reasoning,
    ).toEqual({ mode: 'effort', effort: 'high' });
  });

  it('reads only override fields from an entry', () => {
    // A resolver may return database rows as they are.
    const row = JSON.parse('{"id": 7, "__proto__": {"model": "injected"}, "maxTokens": 5}');

    const merged = resolvePromptOverride('summarize', [{ summarize: row }]);

    expect(merged).toEqual({ maxTokens: 5 });
    expect(merged?.model).toBeUndefined();
    expect(resolvePromptOverride('summarize', [{ summarize: { id: 7 } as never }])).toBeUndefined();
  });
});
