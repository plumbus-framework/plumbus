# Extending @plumbus/chat — Agent Recipe

This file covers the four extension points the framework intentionally exposes. If you're tempted to do something not in this list, stop and read the design docs at `/docs/chat/design/` first — there's probably a reason it's not exposed.

## Extension points

| Want to extend… | Use | Lives at |
|---|---|---|
| Authoring style (per-chat prompt body, output schema additions) | `defineChat({ prompt: customPrompt })` | Pass `definePrompt` result |
| Context resolution (new data source type) | Custom `ContextSource` | Implement the interface |
| Policy behavior (new check the built-ins don't cover) | `policy.custom: Guard[]` | Implement `Guard` type |
| Action confirmation flow | Standard `actions:` + `policy.action` | Use, don't replace |

## Custom Prompt (per-chat)

When the generic `chat.turn` prompt isn't enough — typically because you have a long domain-specific system body or need extra output fields.

```ts
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { defineChat } from '@plumbus/chat';

const helpBotPrompt = definePrompt({
  name: 'help.chat',                         // gets its own AiConfig admin row
  domain: 'support',
  description: `[long system body here]`,
  input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
  output: z.object({
    // REQUIRED — five base fields the runtime depends on
    inScope: z.boolean(),
    answer: z.string(),
    refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
    citedSources: z.array(z.string()),
    requestedAction: z.unknown().nullable(),
    // OPTIONAL — your additions, runtime ignores what it doesn't know
    suggestedNextStep: z.string().optional(),
  }),
  model: { temperature: 0.3, maxTokens: 800 },
});

defineChat({
  name: 'help',
  // ...
  prompt: helpBotPrompt,
});
```

**Do not narrow the output schema.** The five base fields are required by the runtime's scope, provenance, and action guards. Narrowing them silently breaks guards. `defineChat` validates and rejects schemas missing them.

## Custom `ContextSource`

When none of `staticContext`, `staticContextFromTranslations`, `capabilityContext`, `knowledgeContext` fit. Example: a markdown-wiki adapter.

```ts
import type {
  ContextSource,
  ContextItem,
  ChatSourceRef,
  TurnContext,
  ResolvedContext,
} from '@plumbus/chat';
import type { ExecutionContext } from '@plumbus/core';

export function wikiContext(opts: {
  wikiPath: string;
  indexFile?: string;
  topK?: number;
}): ContextSource {
  return {
    // Pick the closest of: 'knowledge' | 'capability' | 'static'
    kind: 'knowledge',
    // Stable ID. NEVER Math.random(). NEVER UUID. Stable across restarts.
    id: `wiki:${opts.wikiPath}`,
    async resolve(ctx: ExecutionContext, turnCtx: TurnContext): Promise<ResolvedContext> {
      // 1. Read your data — file system, http, whatever.
      const pages = await readWikiPages(opts.wikiPath, turnCtx);

      // 2. Convert to ContextItem[]. `sourceId` is OPTIONAL — runtime issues
      //    a handle if you leave it unset.
      const items: ContextItem[] = pages.map((page, i) => ({
        id: page.slug,
        kind: 'text',
        content: page.body,
        classification: 'public',
      }));

      // 3. ChatSourceRef[] is optional metadata for the UI. Leave empty if
      //    sources are unlabeled.
      const sources: ChatSourceRef[] = pages.map((page) => ({
        id: page.slug,                       // your internal ID; the resolver maps to src_a, src_b, ...
        origin: 'knowledge',
        label: page.title,
        url: page.url,
      }));

      return {
        items,
        sources,
        estimatedTokens: items.reduce((s, item) => s + String(item.content).length / 4, 0),
      };
    },
  };
}
```

Use it identically to built-ins: `context: [wikiContext({ wikiPath: '/wiki' })]`.

### Rules for custom context sources

- **Stable IDs.** `Math.random` makes tests flaky. Use a hash of your input config.
- **Read-only.** Context sources must not mutate state. If you need to write, use `actions:` + `policy.action`.
- **Bounded resolve.** The resolver gives each source ~5 seconds (configurable). Honor the timeout via `turnCtx.signal`.
- **No source IDs out of thin air.** Use either your domain IDs (`page.slug`) and let the resolver issue runtime handles, or use the resolver's handles directly.

## Custom Guard

When you need policy logic the built-ins don't cover. Custom guards run AFTER all built-ins, in declaration order.

```ts
import type { Guard } from '@plumbus/chat';

const competitorMentionGuard: Guard = async (turnCtx, state) => {
  const output = state.modelOutput;
  if (typeof output?.answer !== 'string') {
    return { decision: 'allow' };
  }

  const competitors = ['CompetitorX', 'CompetitorY'];
  const mentioned = competitors.find((c) => output.answer.includes(c));
  if (mentioned) {
    return {
      decision: 'block',
      reason: 'my.competitor_mention',
      emit: {
        type: 'notice',
        code: 'my.competitor_mention',
        message: `We don't comment on ${mentioned}.`,
      },
    };
  }

  return { decision: 'allow' };
};

defineChat({
  policy: { custom: [competitorMentionGuard] },
});
```

### Rules for custom guards

- **Return one of three verdicts.** `'allow'`, `'block'`, `'require_confirmation'`. Anything else is a runtime error.
- **Use `emit` for notices**, not direct event-bus calls. The runtime threads `emit` payloads through the same event stream.
- **Read state via `state.modelOutput`**, not via re-querying the database. The runtime has already populated `state.modelOutput` by the time post-turn guards run.
- **Never mutate `state` in unexpected places.** Only the documented contract: setting `state.modelOutput.answer` after redaction (privacy-guard does this) is OK; everything else is risky.

## What NOT to extend

| Want to… | Don't | Use instead |
|---|---|---|
| Reorder the guard pipeline | Override `compilePolicy` | The order is intentionally fixed. Use built-ins + custom |
| Add a new event type | Add to `ChatEvent` union ad-hoc | File an issue; events are part of the wire protocol |
| Persist extra session data | Add columns to `ChatSession` | Use a separate entity in your app, key it on `sessionId` |
| Skip the action confirmation flow | Execute capabilities from a custom guard | Use `actions:` + `policy.action`; that's the safe path |
| Replace the runtime orchestrator | Fork `runChatTurn` | The orchestrator's order is load-bearing for guards, budgets, provenance |
| Bypass the prompt's structured-output schema | Use a prompt with a different output shape | Custom prompts must keep the five base fields |

## Deeper Reference

- `/docs/chat/design/` — every design decision; read before extending
- `src/types/policy.ts` — the `Guard` and `GuardVerdict` types
- `src/types/context.ts` — the `ContextSource`, `ContextItem`, `ChatSourceRef` types
- `src/runtime/run-turn.ts` — the orchestrator (read before assuming where in the pipeline your extension fires)
