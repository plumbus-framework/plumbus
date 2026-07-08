# Per-chat prompt override

> **Locked.** `defineChat({ prompt })`.

## The problem

The chat runtime calls a single generic `chat.turn` prompt by default — a short template that injects the composed system prompt + user message and asks for the structured output `{ inScope, answer, refusalReason, citedSources, requestedAction }`.

This works for simple chats. It breaks down for chats with substantial domain knowledge:

- MemoirAI's help-bot system body was ~200 lines of carefully tuned voice + UI surface knowledge + audience-specific rules. Stuffing it into `instructions: [...]` works mechanically but loses the structured authoring affordance of `definePrompt`.
- `definePrompt`-registered prompts get individual rows in the AI Config admin UI (per-prompt model/temperature/maxTokens overrides). The generic `chat.turn` row covers every chat, so per-chat model tuning becomes impossible.
- Some chats want additional structured output fields beyond the base five (e.g. `suggestedNextStep: string`). One-size-fits-all output blocks this.

## How it works

`defineChat({ prompt })` accepts a `PromptDefinition` to use instead of the generic `chat.turn`:

```ts
const helpBotPrompt = definePrompt({
  name: 'help.chat',                       // distinct prompt, gets its own AiConfig row
  domain: 'support',
  description: `[200-line system body]`,
  input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
  output: z.object({
    // Base five — REQUIRED for runtime guards
    inScope: z.boolean(),
    answer: z.string(),
    refusalReason: z.enum([...]).nullable(),
    citedSources: z.array(z.string()),
    requestedAction: z.unknown().nullable(),
    // Extensions — runtime ignores what it doesn't recognise
    suggestedNextStep: z.string().optional(),
  }),
  model: { temperature: 0.3, maxTokens: 800 },
});

defineChat({
  // ...
  prompt: helpBotPrompt,
});
```

The base five output fields are **required**: the scope, provenance, and action guards depend on them. Custom output fields are allowed but the runtime simply doesn't read them.

When `prompt` is omitted, the generic `chat.turn` prompt is used. Behavior is identical without per-chat prompts.

## Tradeoffs

**What works well:**
- Large, domain-specific system bodies can be authored properly with `definePrompt` rather than as long `instructions:` arrays.
- Per-chat AI Config admin overrides (`prompt.help.chat` row) work out of the box.
- Output schema can be extended for chat-specific structured fields without forking the runtime.

**What you give up:**
- Two prompt registries to remember: the generic one and per-chat overrides. New chats must decide which path to take.
- Custom prompts that *narrow* the output (omit base fields) break the runtime silently in some places (or noisily in others). `defineChat` validates that the prompt's output schema includes the base fields and rejects at config time if not.
- `AiConfig` admin can now show 1 generic row + N per-chat rows. UX needs to make the distinction clear.

## Not a backdoor

The custom prompt still runs through the same runtime — guards, provenance, budgets all still apply. Consumers can't bypass the framework by providing their own prompt; the prompt body becomes the model's instructions, but the runtime still owns the pipeline around it.

---

## Addendum (2026-07-08)

**Validation gap:** As of `@plumbus/chat@0.1.x`, `defineChat` accepts any custom `prompt` without checking that its output schema includes the five base fields. Missing fields fail silently at runtime (guards degrade). Treat the "required base fields" rule as author-time discipline until define-time validation lands.
