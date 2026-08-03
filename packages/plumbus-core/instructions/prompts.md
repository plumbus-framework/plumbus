# Prompts

Prompts are structured AI interaction templates defined with `definePrompt()`. They pair typed Zod `input`/`output` schemas with prompt text and model tuning.

## Prompt content

The actual instructions sent to the provider live in two optional string fields:

| Field | Purpose |
|-------|---------|
| `system` | Stable provider system instructions (role, rules, output format) |
| `description` | User/data prompt content (the main task text) |

Both support simple top-level `{{key}}` substitution from the prompt `input` object.

```ts
import { definePrompt } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const classifyTicket = definePrompt({
  name: "classifyTicket",
  domain: "support",
  system: "You classify support tickets. Return only the requested JSON fields.",
  description: "Ticket text:\n{{ticketText}}\n\nCustomer tier: {{customerTier}}",
  input: z.object({
    ticketText: z.string(),
    customerTier: z.enum(["free", "pro", "enterprise"]).optional(),
  }),
  output: z.object({
    category: z.enum(["billing", "technical", "general"]),
    priority: z.enum(["low", "medium", "high"]),
  }),
  model: {
    temperature: 0.2,
    maxTokens: 300,
  },
});
```

When `system` is omitted, the framework uses the prior single user-message behavior (description only).

### Unsubstituted input

By default, any input keys not referenced as `{{key}}` in `system`/`description` are appended to the user message. Set `appendUnsubstitutedInput: false` to disable that behavior.

## Model configuration

`model` is an optional `ModelConfig` object:

| Field | Type | Notes |
|-------|------|-------|
| `provider` | string? | Routes to a named provider in multi-provider config |
| `name` | string? | Model id (e.g. `gpt-4o-mini`) |
| `temperature` | number? | Sampling temperature |
| `maxTokens` | number? | Max output tokens |
| `reasoningEffort` | `'low' \| 'medium' \| 'high'?` | OpenAI o-series / gpt-5 `reasoning_effort` — sent only when set; other providers ignore it |

**Recommended convention:** omit `provider` and `name` in the prompt definition and resolve them via env (`AI_DEFAULT_PROVIDER`, `AI_DEFAULT_MODEL`, `PROMPT_{NAME}_*`) or the `resolveAiOverrides` hook in `app/server.ts`. Set only `temperature`, `maxTokens`, and (when needed) `reasoningEffort` in the prompt when you want per-prompt tuning baked into the contract.

Bare `z.string()` prompt `output` schemas run in plain text mode (same as a single-string-field object). Prefer that for free-text prompts; use an object schema when you need structured fields.

Resolution order: `resolveAiOverrides` → per-prompt env vars → prompt `model` fields → `AI_DEFAULT_MODEL` / `AI_DEFAULT_PROVIDER`.

## Structured output and streaming flags

| Field | Effect |
|-------|--------|
| `disableStrictStructuredOutputs` | Opt out of strict JSON-schema mode for this prompt |
| `requireStrictStructuredOutputs` | Refuse to run unless a provider JSON Schema can be sent (no silent prompt-only JSON fallback) |
| `structuredOutputTransport` | How structured output is requested from the provider |
| `skipStreamValidationFallback` | On `streamGenerate`, do not fall back to non-streaming retry on validation failure |
| `disableTextModeBrevityHint` | Skip the automatic brevity hint for text-mode prompts |

See `docs/ai/ai-integration.md` for strict structured outputs and streaming behavior.

## Invoking prompts

From capabilities, use `ctx.ai`:

```ts
const result = await ctx.ai.generate({
  prompt: "classifyTicket",
  input: { ticketText: input.body, customerTier: "enterprise" },
});
```

Also available: `generateWithUsage` (returns tokens + cost), `streamGenerate` (async iterator), `extract`, `classify`, `retrieve`. See `ai.md` for the full `ctx.ai` surface.
