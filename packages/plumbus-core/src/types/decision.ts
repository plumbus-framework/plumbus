import type { z } from 'zod';
import type { DecisionQuestions } from '../ai/decision.js';

// ── Decision Model Config ──
/**
 * Which decision provider and model answer a decision.
 *
 * There is no `temperature` or `maxTokens` here on purpose. A decision model
 * returns a calibrated distribution rather than sampled text, so the knobs
 * that shape generation do not apply — you shape answers through the
 * `instructions` and `criteria` of each question instead.
 */
export interface DecisionModelConfig {
  /** Registered decision provider name (e.g. `"typesafe"`). */
  provider?: string;
  /** Model id or alias (e.g. `"jev-latest"`, `"jev-1.13.0"`). */
  name?: string;
}

// ── Decision Definition ──
export interface DecisionDefinition<TQuestions extends DecisionQuestions = DecisionQuestions> {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  /** Optional Zod schema for the state this decision evaluates. */
  state?: z.ZodTypeAny;

  questions: TQuestions;

  model?: DecisionModelConfig;
}

// ── Decision Model Override ──
/** Env/config override for a single decision, keyed by decision name. */
export interface DecisionModelOverride {
  provider?: string;
  model?: string;
}
