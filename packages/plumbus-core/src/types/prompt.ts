import type { z } from 'zod';

// ── Model Config ──
export interface ModelConfig {
  provider?: string;
  name?: string;
  temperature?: number;
  maxTokens?: number;
}

// ── Prompt Definition ──
export interface PromptDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  /**
   * Stable provider system instructions. Like `description`, this supports
   * simple top-level `{{key}}` substitution from the prompt input. Prompts
   * without this field keep the previous single user-message behavior.
   */
  system?: string;
  /** User/data prompt content. Supports simple top-level `{{key}}` substitution. */
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  input: TInput;
  output: TOutput;
  model?: ModelConfig;

  /**
   * When set on a prompt, `streamGenerate` will NOT fall back to a
   * non-streaming retry if the streamed text fails JSON/schema validation.
   * Instead it throws immediately. This is intended for prompts where the
   * fallback would silently re-pay for a huge input-token cost (e.g. a
   * 100K+ input writer call) — the caller is expected to implement its own
   * recovery (e.g. escalate strategy) rather than blindly re-playing the
   * request.
   */
  skipStreamValidationFallback?: boolean;

  /**
   * When the output schema is a single-string-field object (e.g.
   * `z.object({ content: z.string() })`), `streamGenerate` switches to plain
   * text mode and appends a brevity hint to the prompt that tells the model
   * to "Respond with ONLY the plain text content. Do NOT wrap your response
   * in JSON or any other format." That suffix is the right default for
   * short Q&A-style outputs (it suppresses accidental JSON wrapping), but
   * it is misread by some models as an instruction to be *terse*, which
   * collapses long-form outputs (chapters, articles, narratives) into
   * bullet-point summaries.
   *
   * Set this flag to `true` on prompts that need plain-text streaming for
   * a long-form payload — the responseFormat stays `text` (so JSON-escape
   * issues like Hebrew gershayim never apply), but the brevity-hint
   * suffix is omitted, so the model writes at the length the prompt body
   * itself contracts for.
   */
  disableTextModeBrevityHint?: boolean;

  /**
   * By default, any prompt input keys not substituted into `system` or
   * `description` are appended to the user prompt as `Input: {...}`. Set this
   * to `false` when the prompt intentionally renders a complete user message
   * into a single placeholder and should not expose the remaining structured
   * input keys to the model.
   */
  appendUnsubstitutedInput?: boolean;

  /**
   * Opt this prompt out of provider-side structured outputs even when
   * `AIServiceConfig.enableStrictStructuredOutputs` is enabled globally.
   * Use only for schemas that cannot fit the supported provider JSON Schema
   * subset without changing the prompt contract.
   */
  disableStrictStructuredOutputs?: boolean;

  /**
   * Require provider-side structured outputs for this prompt. When set, the AI
   * service refuses to run the prompt unless it can send a provider JSON Schema
   * (`responseSchema`) for the prompt output. Use this for production JSON
   * extraction paths that must not fall back to prompt-only JSON instructions.
   */
  requireStrictStructuredOutputs?: boolean;

  /**
   * Selects the provider transport used for structured JSON output. The default
   * is provider-native `response_format: json_schema`. Use `tool` only for
   * prompts/providers where JSON-schema response content is known to be weak but
   * strict tool-call arguments work reliably.
   */
  structuredOutputTransport?: 'response_format' | 'tool';
}
