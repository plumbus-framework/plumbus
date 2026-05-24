# Defining chats

A chat is declared once with `defineChat({...})`. The config is validated with Zod and frozen — runtime errors come from your handlers and guards, not from accepting bad configs.

## Minimal config

```ts
import { defineChat, knowledgeContext } from '@plumbus/chat';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  instructions: [
    'You are the MemoirAI help assistant.',
    'Answer questions about how to use the product.',
    'You DO NOT perform actions on behalf of the user.',
  ],
  context: [
    knowledgeContext({
      corpus: 'memoir-docs',
      query: (turnCtx) => turnCtx.userMessage,
    }),
  ],
  policy: {
    audience: { roles: ['user', 'admin'], mode: 'strict' },
    scope: { description: 'Help with MemoirAI product usage only.' },
  },
  budget: { perSession: { userMessages: 35 } },
});
```

`name` and `access` are the only required fields. Everything else has a sensible default.

## Full config shape

```ts
defineChat({
  name: 'billingChat',                       // unique within the app
  description?: 'Conversational billing help', // for docs / AI Config admin UI

  access: {                                   // standard Plumbus AccessPolicy
    roles: ['user'],
    tenantScoped: true,
  },

  instructions?: [                            // joined with '\n' into the system prompt
    'You are a billing assistant.',
    'You only answer about the calling user\'s own billing.',
  ],

  context?: [                                 // see context-sources below
    capabilityContext(getOwnBillingStatus),
    knowledgeContext({ corpus: 'billing-docs', query: (t) => t.userMessage }),
  ],

  actions?: ['openSupportTicket'],            // capability names enabled for action-guard

  policy?: {
    audience?:    { roles, default?, mode: 'strict' | 'permissive' },
    scope?:       { description?, classifier?: 'inline', locales?: ['en','he'] },
    reply?:       { locale: 'auto' | 'en' | 'he' | ... },
    privacy?:     { redact: ['ssn', 'cardNumber'] },
    provenance?:  { required: true, minSources?: 1 },
    behavioral?:  { cooldowns: [{ trigger, count, durationSeconds, scope }] },
    action?:      { allowedCapabilities: ['openSupportTicket'] },
    custom?:      [myGuard],                  // run after built-ins
  },

  budget?: {
    perTurn?:     { tokens?: 6000, costUsd?: 0.05 },
    perSession?:  { turns?: 60, userMessages?: 35, tokens?: 200000, costUsd?: 1.50 },
    perUser?:     { turnsPerHour?: 60, turnsPerDay?: 600, costUsdPerDay?: 5 },
    perTenant?:   { costUsdPerDay?: 1000 },
    contextTokens?: 8000,
    actions?:     { perSession?: 5 },
    timeout?:     { perTurnSeconds?: 120 },
  },

  history?: {
    includeLastTurns?: 8,                     // window for server-persistence chats
    summarize?: {                             // opt-in older-turn compression
      strategy: 'rolling',
      thresholdTurns: 20,
      targetTokens: 800,
    },
  },

  persistence?: {                             // Decision 0009
    messageContent: 'server' | 'client',      // default 'server'
  },

  exposeAs?: 'sse' | 'capability' | 'both',   // default 'sse' (see below)

  prompt?: customPrompt,                      // Decision 0008; defaults to generic chat.turn
});
```

## Per-chat prompt override (Decision 0008)

By default every chat runs through the generic `chat.turn` prompt — a short template that injects the system prompt + user message and asks for `{ inScope, answer, refusalReason, citedSources, requestedAction }` as structured output.

When that's not enough (long domain-specific system body, custom AI Config admin overrides, extended output fields), register your own `definePrompt` and pass it:

```ts
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

const helpBotPrompt = definePrompt({
  name: 'help.chat',                          // gets its own AiConfig admin row
  domain: 'support',
  description: `You are the MemoirAI help bot. [...200 lines of system body...]`,
  input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
  output: z.object({
    inScope: z.boolean(),                     // base fields are mandatory
    answer: z.string(),
    refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
    citedSources: z.array(z.string()),
    requestedAction: z.unknown().nullable(),
    // Extra fields are OK — runtime ignores what it doesn't recognise.
    suggestedNextStep: z.string().optional(),
  }),
  model: { temperature: 0.3, maxTokens: 800 },
});

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  prompt: helpBotPrompt,
  // ... rest of config
});
```

**The five base output fields are required** — the runtime's scope, provenance, and action guards depend on them. Custom fields can be added freely.

## `exposeAs` — controlling the public surface

Plumbus auto-routes every capability. Chat needs a streaming SSE wire too. `exposeAs` resolves the conflict:

| Value | What gets registered | When to use |
|---|---|---|
| `'sse'` (default) | Only `POST /chat/:name/turn` (SSE). The underlying capability is internal — its auto-route exists but is gated. | Almost always. Browser clients want SSE; the capability is an implementation detail. |
| `'capability'` | Only the auto-routed JSON capability `POST /api/chat/chat-turn`. No SSE. | Server-to-server scripted clients, integration tests, agents that don't need streaming. |
| `'both'` | Both surfaces public. | Rare. Document explicitly why. |

## Persistence mode (Decision 0009)

| `persistence.messageContent` | What's stored server-side | Client responsibility |
|---|---|---|
| `'server'` (default) | Full message content on `ChatTurnRow.content`, plus metadata | Just render messages from SSE events |
| `'client'` | Empty string on `ChatTurnRow.content`. Metadata still persisted (token counts, refusal reasons, abuse counters, cost) | Send the last 20 turns as `clientHistory` on every `POST /chat/:name/turn` so the model has context |

The 20-message cap mirrors the server's `CLIENT_HISTORY_MAX_MESSAGES`. The server validates and rejects oversized payloads with `400 + chat.client_history_too_large`. **Client-sent history is NOT authoritative** — abuse limits, budgets, cooldowns all compute from the always-persisted metadata. A malicious client can lie about its conversation prose but cannot inflate its own limits.

Pick `'server'` for audit + cross-device continuity (the default). Pick `'client'` for privacy-sensitive chats where you don't want message text in the DB at all.

## Examples

### Help bot (knowledge-grounded, audience-aware, no actions)

```ts
defineChat({
  name: 'help',
  access: { roles: ['user', 'admin'] },
  instructions: [/* product knowledge */],
  context: [
    knowledgeContext({
      corpus: 'product-docs',
      query: (t) => t.userMessage,
      filter: (t) => ({ audience: t.audience, locale: t.locale }),
    }),
    staticContextFromTranslations({ namespaces: ['nav', 'admin.nav'] }),
  ],
  policy: {
    audience: { roles: ['user', 'admin'], mode: 'strict' },
    reply: { locale: 'auto' },
    behavioral: { cooldowns: [
      { trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' },
    ]},
    scope: { description: 'Help with this product only.' },
  },
  budget: { perSession: { userMessages: 35 } },
  persistence: { messageContent: 'client' },
});
```

### Billing chat (live data via capability, actions with confirmation)

```ts
defineChat({
  name: 'billing',
  access: { roles: ['user'] },
  instructions: ['You answer the calling user\'s own billing questions.'],
  context: [
    capabilityContext(getOwnBillingStatus),
    knowledgeContext({ corpus: 'billing-docs', query: (t) => t.userMessage }),
  ],
  actions: ['openSupportTicket'],
  policy: {
    audience: { roles: ['user'], mode: 'strict' },
    scope: { description: 'Caller\'s own billing only.' },
    provenance: { required: true },
    action: { allowedCapabilities: ['openSupportTicket'] },
  },
  budget: {
    perSession: { costUsd: 0.50 },
    perUser: { turnsPerDay: 50 },
    actions: { perSession: 2 },
  },
});
```

## Common pitfalls

- **`context: []` is allowed but warned.** Pure-model chats with no grounding are valid but uncommon. The warning fires at `defineChat` time; the runtime won't reject.
- **`capabilityContext` rejects write-effect capabilities at construction time.** If your capability has any `effects.data` or `effects.events`, it can't be used as a context source. Use it through `actions:` + `policy.action` instead so it goes through confirmation.
- **`audience.mode: 'strict'` requires `roles: ['user']`** at minimum. Empty roles in strict mode is a `defineChat` validation error.
- **The `chat.turn` prompt's output schema cannot be narrowed in a custom prompt** — only widened. Removing `inScope` would break the scope guard.

## End-to-end example: a complete help-bot

A real production help-bot exercises most of the framework. This example covers: multi-audience, multi-locale, refusal cooldown, RAG-grounded, translation-sync'd, abuse-capped, client-persistence, per-chat prompt with AI Config admin overrides.

```ts
// app/prompts/help-bot.prompt.ts
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const helpBotPrompt = definePrompt({
  name: 'help.chat',
  domain: 'support',
  description: `You are the in-product help assistant for ProductX.

Voice: warm, concise, factual. Never invent features.
Surface vocabulary: refer to UI elements by their on-screen labels.
When the user is in Hebrew, reply in Hebrew using the Hebrew surface names.
If the question is outside ProductX, set inScope=false with refusalReason='off_topic'.
If the question asks you to perform an action on the user's behalf, set inScope=false with refusalReason='asking_for_action'.

Cite at least one source from the provided context when answering factual questions.
Use the [src:src_X] inline marker — never invent source IDs.
`,
  input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
  output: z.object({
    inScope: z.boolean(),
    answer: z.string(),
    refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
    citedSources: z.array(z.string()),
    requestedAction: z.unknown().nullable(),
  }),
  model: { temperature: 0.3, maxTokens: 800 },
});

// app/chats/help.chat.ts
import {
  defineChat,
  knowledgeContext,
  staticContextFromTranslations,
} from '@plumbus/chat';
import { helpBotPrompt } from '../prompts/help-bot.prompt.js';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user', 'admin'], tenantScoped: true },
  prompt: helpBotPrompt,

  instructions: [
    'You serve both user-app callers and admin-panel callers.',
    'Use the audience anchor in the prompt to pick the right surface vocabulary.',
  ],

  context: [
    staticContextFromTranslations({
      id: 'nav-surfaces',
      namespaces: ['nav', 'admin.nav'],
      sourceId: 'product-nav',
    }),
    knowledgeContext({
      id: 'docs',
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage,
      topK: 6,
      filter: (turnCtx) => ({
        audience: turnCtx.audience,        // admin docs not served to users
        locale: turnCtx.locale,            // language-matched chunks
      }),
    }),
  ],

  policy: {
    audience: { roles: ['user', 'admin'], mode: 'strict' },
    reply: { locale: 'auto' },
    scope: {
      description: 'Answer how-to questions about ProductX. No advice on other products, no creative writing, no action execution.',
      locales: ['en', 'he'],
    },
    provenance: { required: false },
    behavioral: {
      cooldowns: [
        { trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' },
      ],
    },
  },

  budget: {
    perTurn: { tokens: 6000 },
    perSession: { userMessages: 35, costUsd: 0.50 },
    perUser: { turnsPerDay: 100, costUsdPerDay: 2.00 },
    contextTokens: 4000,
    timeout: { perTurnSeconds: 30 },
  },

  history: {
    includeLastTurns: 8,
    summarize: { strategy: 'threshold', thresholdTurns: 20, targetTokens: 600 },
  },

  persistence: { messageContent: 'client' },
  exposeAs: 'sse',
});

// app/server.ts (excerpt)
import { onRoutesRegistered } from '@plumbus/core';
import { registerChatRoutes } from '@plumbus/chat';
import { helpChat } from './chats/help.chat.js';

onRoutesRegistered((app, routeConfig) => {
  registerChatRoutes(app, routeConfig, [helpChat]);
});

// app/entities/index.ts (excerpt)
import {
  chatSessionEntity,
  chatTurnEntity,
  chatPendingActionEntity,
} from '@plumbus/chat';

export const entities = [
  // ... your own entities ...
  chatSessionEntity,
  chatTurnEntity,
  chatPendingActionEntity,
];
```

UI side:

```tsx
// app/components/HelpButton.tsx
'use client';
import { ChatPanel } from '@plumbus/chat-ui';
import { useState } from 'react';

export function HelpButton() {
  const [open, setOpen] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());

  return (
    <>
      <button onClick={() => setOpen(true)}>?</button>
      {open && (
        <ChatPanel
          chatName="help"
          sessionId={sessionId}
          audience="user"
          locale="en"
          persistence="client"
          turnUrl="/api/chat/help/turn"
        />
      )}
    </>
  );
}
```

That's everything: persisted session + turn metadata, abuse cooldown, multi-locale, citation provenance, all wired.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `defineChat throws "name is required"` | Empty `name` field | Provide a camelCase name |
| `defineChat throws "audience roles required in strict mode"` | `policy.audience.roles: []` with default `mode: 'strict'` | Add at least one role, or set `mode: 'permissive'` |
| `defineChat throws "capability has write effects"` | Tried to use a write-effect capability as `capabilityContext` | Move it to `actions:` + `policy.action.allowedCapabilities` |
| Warning: `context is empty — chat has no grounding sources` | `context: []` | Add at least one source, OR ignore if you really want a pure-model chat |
| HTTP 400 `chat.client_history_too_large` | `clientHistory` payload > 20 messages or any message > 4000 chars | UI should cap before sending; check `buildTurnRequestBody` is wired |
| `notice: chat.cooldown_active` | User hit a refusal-count or guard-failure threshold | Wait `retryAfterSeconds`. Adjust `policy.behavioral.cooldowns` if too aggressive |
| `notice: chat.out_of_scope` | Model returned `inScope: false` | The scope guard worked. If false-positive, tighten `policy.scope.description` or move logic into a custom guard |
| `notice: chat.provenance_missing` | `policy.provenance.required: true` and model didn't cite valid sources | Either let the model cite, or set `provenance.required: false` |
| Model cites `[src:src_zzz]` and the UI shows nothing | Model invented a source ID | Runtime strips it automatically. Verify in `trace.modelOutput.citedSources` |
| Tests show ordinals all = 0 | Forgot to use `appendTurn` (which auto-increments) | Always go through `session/service.ts` helpers, not raw repo writes |

## Source file map

If you need to read or change the chat package, here's where things live:

| Concern | File |
|---|---|
| `defineChat` validation | [`packages/chat/src/define/defineChat.ts`](../../packages/chat/src/define/defineChat.ts) |
| Turn orchestrator | [`packages/chat/src/runtime/run-turn.ts`](../../packages/chat/src/runtime/run-turn.ts) |
| HTTP route helper | [`packages/chat/src/runtime/http.ts`](../../packages/chat/src/runtime/http.ts) |
| Event protocol | [`packages/chat/src/types/event.ts`](../../packages/chat/src/types/event.ts) |
| Context resolver | [`packages/chat/src/context/resolver.ts`](../../packages/chat/src/context/resolver.ts) |
| Built-in context helpers | [`packages/chat/src/context/`](../../packages/chat/src/context/) |
| Policy guard registry | [`packages/chat/src/policy/registry.ts`](../../packages/chat/src/policy/registry.ts) |
| Built-in guards | [`packages/chat/src/policy/`](../../packages/chat/src/policy/) |
| Session entities | [`packages/chat/src/session/`](../../packages/chat/src/session/) |
| Budget enforcer | [`packages/chat/src/budget/enforcer.ts`](../../packages/chat/src/budget/enforcer.ts) |
| History + summarizer | [`packages/chat/src/history/`](../../packages/chat/src/history/) |
| Generic chat prompt | [`packages/chat/src/prompt/chat-turn.prompt.ts`](../../packages/chat/src/prompt/chat-turn.prompt.ts) |
| Provenance issuer/validator | [`packages/chat/src/runtime/provenance.ts`](../../packages/chat/src/runtime/provenance.ts) |
| `useChat` hook | [`packages/chat-ui/src/hooks/useChat.ts`](../../packages/chat-ui/src/hooks/useChat.ts) |
| Pure UI helpers | [`packages/chat-ui/src/hooks/useChat-helpers.ts`](../../packages/chat-ui/src/hooks/useChat-helpers.ts) |
| SSE parser | [`packages/chat-ui/src/client/event-stream.ts`](../../packages/chat-ui/src/client/event-stream.ts) |
| `<ChatPanel>` + sub-components | [`packages/chat-ui/src/components/`](../../packages/chat-ui/src/components/) |
