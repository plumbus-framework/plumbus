# Extending @plumbus/chat — Agent Recipe

This file covers the four extension points the framework intentionally exposes. If you're tempted to do something not in this list, stop and read the design docs at `/docs/chat/design/` first — there's probably a reason it's not exposed.

## Extension points

| Want to extend… | Use | Lives at |
|---|---|---|
| Authoring style (per-chat prompt body, output schema additions) | `defineChat({ prompt: customPrompt })` | Pass `definePrompt` result |
| Context resolution (new data source type) | Custom `ContextSource` | Implement the interface |
| Policy behavior (new check the built-ins don't cover) | `policy.custom: Guard[]` | Implement `Guard` type |
| Action confirmation flow | Path A: `actions:` + `policy.action`. Path B: `policy.toolCalling` (model calls capabilities/flows as provider-native tools) | Use, don't replace |
| Where session/turn state is stored | `runChatTurn(ctx, args, { sessionStore })` | Implement `ChatSessionStore` |

## Session storage (no local database)

Use this **only** when the app genuinely cannot reach `ctx.data` for chat — conversation memory lives on a remote platform or behind a port. If the app has a database, use the default; do not write an adapter to "customize" persistence.

```ts
import type { ChatSessionStore } from '@plumbus/chat';

const store: ChatSessionStore = {
  /* getOrCreateSession, loadSession, appendTurn, countTurns, listTurns,
     updateSessionBehavioralState, updateSessionSummary, loadMergedUserBehavioralState */
};

registerChatRoutes(app, routeConfig, chats, { sessionStore: store, authenticator });
```

Rules:

- **Do not fork `runChatTurn`.** Injecting a store is the supported way to run the pipeline on non-DB memory; re-stitching `compilePolicy` / `resolveContextSources` / `buildSystemPrompt` yourself is the thing this replaces.
- **Honor the documented invariants** — `appendTurn` assigns the ordinal and advances `lastTurnAt`, `persistContent: false` means store empty content, `getOrCreateSession` raises `notFound` on a userId mismatch, `listTurns` is ascending by ordinal. They are listed in full on the `ChatSessionStore` doc comment and in `/docs/chat/session-store.md`.
- **Implement `aggregateForBudget` if any chat declares a `budget`,** and `countActivePendingActions` if any sets `budget.actions.perSession`. Omitting them is a startup failure (`chat.budget_unsupported`), not a silent skip.
- **Tool confirmations need the second tier.** They require atomic compare-and-set writes; pass a `ChatConversationStore` as `store` too, or the chat must not enable `policy.toolCalling` / `policy.action.allowedCapabilities`.
- **In custom guards, read `state.sessionStore`** via `resolveChatSessionStore(state.sessionStore)` — never `ctx.data` directly, or the guard breaks under an injected store.
- **Start from `createInMemoryChatSessionStore`** in `@plumbus/chat/testing`; it implements the full required tier-1 surface. For `countActivePendingActions`, copy `dbChatSessionStore`'s version in `src/session/session-store.ts`.

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

**Do not narrow the output schema.** The five base fields are required by the runtime's scope, provenance, and action guards. Narrowing them breaks guards at runtime — `defineChat` now emits a **one-time define-time warning** when a custom prompt's output schema is not a Zod object or omits any of the five base fields (`warnMissingChatPromptBaseFields`).

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
- **Bounded resolve.** The resolver enforces a per-source timeout (default 5000 ms in `runChatTurn`; override with `contextResolution.perSourceTimeoutMs`). Hung sources are aborted and skipped with a structured `ctx.logger.warn` — honor `turnCtx.signal` in custom `resolve()` implementations and keep work fast.
- **No source IDs out of thin air.** Use either your domain IDs (`page.slug`) and let the resolver issue runtime handles, or use the resolver's handles directly.

## Custom Guard (post-turn)

When you need policy logic the built-ins don't cover after the model runs. Custom **post-turn** guards run after built-ins, in declaration order.

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
  policy: { customPostTurn: [competitorMentionGuard] },
});
```

### Rules for custom guards

- **Return one of three verdicts.** `'allow'`, `'block'`, `'require_confirmation'`. Anything else is a runtime error.
- **Use `emit` for notices**, not direct event-bus calls. The runtime threads `emit` payloads through the same event stream.
- **Read `state.modelOutput` only in `policy.customPostTurn` guards.** Pre-turn `policy.custom` runs before the model call — `state.modelOutput` is undefined there.
- **Never mutate `state` in unexpected places.** Only the documented contract: setting `state.modelOutput.answer` after redaction (privacy-guard does this) is OK; everything else is risky.

## What NOT to extend

| Want to… | Don't | Use instead |
|---|---|---|
| Reorder the guard pipeline | Override `compilePolicy` | The order is intentionally fixed. Use built-ins + custom |
| Add a new event type | Add to `ChatEvent` union ad-hoc | File an issue; events are part of the wire protocol |
| Persist extra session data | Add columns to `ChatSession` | Use a separate entity in your app, key it on `sessionId` |
| Skip the action confirmation flow | Execute capabilities from a custom guard | Use `actions:` + `policy.action` (Path A) or `policy.toolCalling` (Path B); those are the safe paths |
| Replace the runtime orchestrator | Fork `runChatTurn` | The orchestrator's order is load-bearing for guards, budgets, provenance. If the blocker is storage, inject a `sessionStore` instead |
| Bypass the prompt's structured-output schema | Use a prompt with a different output shape | Custom prompts must keep the five base fields |

## Deeper Reference

- `/docs/chat/design/` — every design decision; read before extending
- `/docs/chat/session-store.md` — the two-tier storage contract, adapter invariants, startup validation
- `defining-chats.md` / `policies.md` (this folder) — `policy.toolCalling` (Path B): letting the model call capabilities/flows as provider-native tools instead of the single-shot Path A `requestedAction`
- `src/types/policy.ts` — the `Guard` and `GuardVerdict` types
- `src/types/context.ts` — the `ContextSource`, `ContextItem`, `ChatSourceRef` types
- `src/runtime/run-turn.ts` — the orchestrator (read before assuming where in the pipeline your extension fires)
