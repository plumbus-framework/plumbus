// ── Per-prompt model overrides ──
// How one prompt's runtime override is put together from the env layer (PROMPT_{NAME}_*) and the
// dynamic layer (`resolveAiOverrides`).

import type { PromptModelOverride } from '../types/config.js';

/** A set of per-prompt overrides, keyed by prompt name or by its env-style key. */
export type PromptOverrideMap = Readonly<Record<string, PromptModelOverride | null | undefined>>;

/**
 * The key a `PROMPT_{NAME}_*` env override is stored under for a prompt: its name in lower case
 * with dots turned into underscores (`report.summarize` → `report_summarize`).
 */
export function promptOverrideEnvKey(promptName: string): string {
  return promptName.toLowerCase().replaceAll('.', '_');
}

/**
 * The override fields merged one by one. `reasoning` and its deprecated shorthand
 * `reasoningEffort` are not listed: they are one setting (see `mergeSetFields`). Typed as a record
 * so a new `PromptModelOverride` field fails to compile until it is listed here or there.
 */
const SINGLE_FIELDS: Record<
  Exclude<keyof PromptModelOverride, 'reasoning' | 'reasoningEffort'>,
  true
> = { provider: true, model: true, temperature: true, maxTokens: true, timeoutMs: true };

/**
 * Copies the fields `entry` sets (not `undefined` or `null`) over `target`. Only override fields
 * are read; other keys an app's resolver returns (a database row's `id`) are ignored.
 */
function mergeSetFields(
  target: PromptModelOverride,
  entry: PromptModelOverride | null | undefined,
) {
  if (entry == null) return;
  for (const field of Object.keys(SINGLE_FIELDS) as (keyof typeof SINGLE_FIELDS)[]) {
    const value = entry[field];
    if (value != null) (target as Record<string, unknown>)[field] = value;
  }
  // One setting: an entry that sets either replaces both, so a lower layer's `reasoning` cannot
  // outrank a higher layer's `reasoningEffort` (adapters prefer `reasoning` when both are sent).
  if (entry.reasoning != null || entry.reasoningEffort != null) {
    target.reasoning = entry.reasoning ?? undefined;
    target.reasoningEffort = entry.reasoningEffort ?? undefined;
  }
}

/**
 * One prompt's override, merged field by field from `layers`, lowest precedence first (the env
 * `PROMPT_{NAME}_*` layer, then the `resolveAiOverrides` layer). In each layer an entry is found
 * by the prompt's own name (`report.summarize`) and by its env-style key (`report_summarize`);
 * the entry under the prompt's own name wins when both set a field. A field a higher layer leaves
 * unset keeps the lower layer's value, so a dynamic `{ model }` keeps the env `MAX_TOKENS` and
 * `TIMEOUT_MS`. `reasoning` and `reasoningEffort` count as one field: the entry that sets either
 * decides both. Returns `undefined` when no layer sets anything for the prompt.
 */
export function resolvePromptOverride(
  promptName: string,
  layers: ReadonlyArray<PromptOverrideMap | undefined>,
): PromptModelOverride | undefined {
  const envKey = promptOverrideEnvKey(promptName);
  const merged: PromptModelOverride = {};
  for (const layer of layers) {
    if (!layer) continue;
    // Own keys only: a prompt named `constructor` must not read Object.prototype.
    if (envKey !== promptName && Object.hasOwn(layer, envKey)) {
      mergeSetFields(merged, layer[envKey]);
    }
    if (Object.hasOwn(layer, promptName)) mergeSetFields(merged, layer[promptName]);
  }
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}
