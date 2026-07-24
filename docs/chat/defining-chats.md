# Defining chats

A chat is declared once with `defineChat({...})`. The config is validated with Zod and frozen — runtime errors come from your handlers and guards, not from accepting bad configs.

## Minimal config

```ts
import { defineChat, ragContext } from '@plumbus/chat';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  instructions: [
    'You are the AcmeApp help assistant.',
    'Answer questions about how to use the product.',
    'You DO NOT perform actions on behalf of the user.',
  ],
  context: [
    ragContext({
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage ?? '',
    }),
  ],
  policy: {
    audience: { roles: ['user', 'admin'], mode: 'strict' },
    scope: { description: 'Help with AcmeApp product usage only.' },
  },
  budget: { perSession: { userMessages: 35 } },
});
```

`name` and `access` are the only required fields. Everything else has a sensible default.

## Budget enforcement

All knobs below are enforced in `runChatTurn` / `checkBudgetPreflight` unless noted.

| Knob | When checked | On breach |
|---|---|---|
| `perSession.turns`, `tokens`, `costUsd`, `userMessages` | Pre-turn (`checkBudgetPreflight`) when `saveToDb: true` | `chat.budget_exceeded` before model call |
| `perSession.userMessages` | Pre-turn inline when `saveToDb: false` | Counts user messages in `clientHistory + 1` |
| `perUser.*`, `perTenant.costUsdPerDay` | Pre-turn aggregates | `chat.budget_exceeded` |
| `perTurn.tokens`, `perTurn.costUsd` | Post-generation, before `message.delta` | `notice` + `turn.failed`; answer suppressed |
| `contextTokens` | After context resolution | `trimContextToBudget` drops items |
| `actions.perSession` | Post-turn in `action-guard` | Blocks new pending actions |
| `timeout.perTurnSeconds` | Model call `AbortSignal` | Provider timeout |

`provenance.minSources` is enforced in the provenance guard (not the budget enforcer).

Unset knobs remain unlimited. Apps that previously set limits expecting silent no-ops will now see hard failures — see [upgrading-contract-alignment.md](../upgrading-contract-alignment.md#4-chat-budget-knobs-enforced-c7).

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
    ragContext({ corpus: 'billing-docs', query: (t) => t.userMessage ?? '' }),
  ],

  actions?: ['openSupportTicket'],            // capability names enabled for action-guard

  policy?: {
    audience?:    { roles, default?, mode: 'strict' | 'permissive' },
    scope?:       { description?, classifier?: 'inline', locales?: ['en','he'] },
    reply?:       { locale: 'auto' | 'en' | 'he' | ... },
    privacy?:     { redact: ['ssn', 'cardNumber'] },
    provenance?:  { required: true, minSources?: 1 },
    behavioral?:  { cooldowns: [{ trigger, count, durationSeconds, scope }] },
    action?:      { allowedCapabilities: ['openSupportTicket'], frameworkExecuteOnConfirm?: false },  // Path A; frameworkExecuteOnConfirm defaults false (decision-only)
    toolCalling?: {                           // Path B — provider-native tool calling (see below)
      enabled: true,
      capabilities?: ['openSupportTicket'],   // capability tools (confirm/auto per binding)
      autoStartFlows?: ['refundFlow'],        // flow tools, bound flow__<name>
      maxToolRounds?: 5,                       // default 5, range 1..20
      maxTools?: 32,                           // default 32, range 1..64
      flowAwaitMs?: 10000,                     // default 10_000
      flowPollIntervalMs?: 250,                // default 250
      flowAwaitBudgetMsPerTurn?: 15000,        // default 15_000; 0 disables flow polling
      maxFlowStartsPerTurn?: 2,                // default 2, range 0..20
      confirmationTtlMs?: 900000,              // default 900_000 (15 min)
    },
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
    saveToDb?: boolean,                       // default true (see "Persistence mode")
  },

  exposeAs?: 'sse' | 'capability' | 'both',   // default 'sse' (see below)
  streaming?: boolean,                        // default true (SSE); false → JSON request/response

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
  description: `You are the AcmeApp help bot. [...200 lines of system body...]`,
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

## Provider-native tool calling (`policy.toolCalling`, Path B)

`policy.toolCalling` turns capabilities and flows into provider-native tools the model
calls over a bounded per-turn loop, instead of the single-shot `requestedAction` field
(Path A). The two paths coexist; Path B is opt-in.

```ts
export const supportChat = defineChat({
  name: 'support',
  access: { roles: ['user'] },
  policy: {
    toolCalling: {
      enabled: true,
      capabilities: ['lookupOrder', 'openSupportTicket'],
      autoStartFlows: ['issueRefund'],
      maxToolRounds: 5,
    },
  },
});
```

Requirements and behavior:

- **Prompts must be registered (step a).** Re-export `chatToolRoundPrompt` and
  `chatScopeCheckPrompt` from `@plumbus/chat` into `app/prompts/` so directory discovery
  registers `chat.toolRound` and `chat.scopeCheck` (same one-time wiring as `chat.turn`).
  If either is missing, the first Path B turn fails with `chat.prompt_not_registered`
  (a per-turn `turn.failed`, not a boot-time error).
- **Chat registry must be wired (step b).** Build `createChatRegistry(promptRegistry)` from
  the runtime `PromptRegistry` and pass it as the `chatRegistry` opt of
  `registerChatRoutes(app, config, chats, { store, chatRegistry })`. Without it Path B
  cannot resolve `chat.toolRound` / `chat.scopeCheck`, so the first turn fails the same way.
- **Storage must be transactional.** Path B uses the lease-based `ChatConversationStore`
  and a unique `(sessionId, ordinal)` index. Adapters without a conditional/transactional
  write path fail closed at startup with `chat.storage_unsupported`.
- **Auto vs confirm.** Auto-mode tools execute inline through the capability pipeline
  (access policy still enforced). Confirm-mode tools pause the turn with
  `confirmation_required`; the client commits with `POST /chat/:name/confirm`, which
  executes the tool and resumes the turn for a single answer-only completion (no further
  tool rounds or nested confirmation).
- **Flows** are bound as `flow__<flowName>` tools (portable grammar, flow names ≤ 57
  chars). `maxFlowStartsPerTurn` and `flowAwaitBudgetMsPerTurn` bound the work per turn.
- **Round limit** is non-fatal: at `maxToolRounds` the runtime makes one final tool-less
  model call and emits a `chat.tool_round_limit` notice.
- **Chat does not use core's `runToolLoop`** — the chat loop default is `maxToolRounds: 5`;
  core's `runToolLoop` default (8, hard cap 20) is for capability authors.

Full error/status semantics: [policies.md → Tool calling (Path B)](./policies.md#tool-calling-path-b).
Design rationale: [design/tool-calling.md](./design/tool-calling.md).

## `exposeAs` — controlling the public surface

Plumbus auto-routes every capability. Chat needs a streaming SSE wire too. `exposeAs` resolves the conflict:

| Value | What gets registered | When to use |
|---|---|---|
| `'sse'` (default) | Only `POST /chat/:name/turn` (SSE). No JSON chat-turn capability route is registered. | Almost always. Browser clients want SSE. |
| `'capability'` | No SSE route. The app must register `createChatTurnCapability(chat)` separately; core auto-routes it at `/api/chat/chat-turn-<name>`. | Server-to-server scripted clients, integration tests, agents that don't need streaming. |
| `'both'` | SSE route plus whatever capability routes the app registers. | Rare. Document explicitly why. |

## Persistence mode (Decision 0009)

Two independent knobs sit under `persistence`. `messageContent` controls where the prose lives; `saveToDb` controls whether the runtime writes to the chat tables at all.

### `persistence.messageContent`

| `messageContent` | What's stored server-side | Client responsibility |
|---|---|---|
| `'server'` (default) | Full message content on `ChatTurnRow.content`, plus metadata | Just render messages from SSE events |
| `'client'` | Empty string on `ChatTurnRow.content`. Metadata still persisted (token counts, refusal reasons, abuse counters, cost) | Send the last 20 turns as `clientHistory` on every `POST /chat/:name/turn` so the model has context |

The 20-message cap mirrors the server's `CLIENT_HISTORY_MAX_MESSAGES`. The server validates and rejects oversized payloads with `400 + chat.client_history_too_large`. **Client-sent history is NOT authoritative** — abuse limits, budgets, cooldowns all compute from the always-persisted metadata. A malicious client can lie about its conversation prose but cannot inflate its own limits.

Pick `'server'` for audit + cross-device continuity (the default). Pick `'client'` for privacy-sensitive chats where you don't want message text in the DB at all.

### `persistence.saveToDb`

`saveToDb` controls whether the runtime writes to the chat tables at all. Default `true`.

| `saveToDb` | Chat-table writes | Cooldowns / budgets enforced from | Use case |
|---|---|---|---|
| `true` (default) | `chat_session` + `chat_turn` + `chat_pending_action` rows are written | Persisted `ChatSession.behavioralState` and per-session/per-user/per-tenant counters | Audit trail, cross-device continuity, action confirmation, server-authoritative state |
| `false` | None. Sessions are ephemeral; the client owns `sessionId` generation | The `clientHistory` payload alone (each assistant message carries the optional `refusalReason` it received last turn) | In-product help widgets and other surfaces where DB durability is overkill |

When `saveToDb: false`, `defineChat` enforces two cascading rules:

- **Must combine with `messageContent: 'client'`.** There is no `chat_turn` row to hold server-side content. Trying to set `messageContent: 'server'` is rejected at `defineChat` time with a clear error.
- **Cannot enable `policy.action.allowedCapabilities`.** Pending actions require `chat_pending_action` rows to survive across the propose → confirm round-trip. Action-confirmation flows are unavailable on ephemeral chats.

Cost recording via `onAICostRecorded` is unaffected — costs still flow through the AI service's `AICostContext` regardless of `saveToDb`.

## Serving chats over HTTP (`registerChatRoutes`)

`registerChatRoutes(app, routeConfig, chats, opts?)` registers one `POST /chat/:name/turn` route per chat. By default the route is SSE; set `streaming: false` on the chat to register a JSON request/response route at the same path instead.

The fourth argument is an optional `RegisterChatRoutesOpts`:

```ts
import { registerChatRoutes, type RegisterChatRoutesOpts } from '@plumbus/chat';

const opts: RegisterChatRoutesOpts = {
  authCookieNames: ['session', 'auth_token'],
  audienceTenantOverride: (audience, auth) =>
    audience === 'admin' ? auth.tenantId : undefined,
  beforeTurn: async (ctx, parsed, rawBody) => {
    if (parsed.userMessage.length > 4000) {
      return { error: { status: 400, body: { error: 'too long' } } };
    }
    return { userMessage: parsed.userMessage.trim() };
  },
  afterTurn: async (ctx, rawBody, events) => {
    ctx.logger.info('chat.turn.served', { count: events.length });
  },
};

registerChatRoutes(app, routeConfig, [helpChat, billingChat], opts);
```

| Option | When to use |
|---|---|
| `authCookieNames` | Browser callers ship the session token in a cookie rather than the `Authorization` header. Listed names are tried in order; the first non-empty cookie becomes `Bearer <value>`. |
| `audienceTenantOverride` | Public/multi-tenant chats where the audience implies a tenant the auth adapter couldn't infer (e.g. anonymous `audience: 'support'` → marketing tenant). Only applied when `auth.tenantId` is empty. |
| `beforeTurn` | Mutate the user message (sanitise, normalise) or short-circuit with a typed `{ error: { status, body } }` reply before any runtime work fires. |
| `afterTurn` | Observability / audit. Receives the full ordered `ChatEvent[]` after the turn completes (or after the SSE stream ends). Errors are swallowed with a `console.warn`; do not rely on this for correctness. |

## Examples

### Help bot (knowledge-grounded, audience-aware, no actions)

```ts
defineChat({
  name: 'help',
  access: { roles: ['user', 'admin'] },
  instructions: [/* product knowledge */],
  context: [
    ragContext({
      corpus: 'product-docs',
      query: (t) => t.userMessage ?? '',
      filter: (t) => ({ audience: t.audience, locale: t.locale }),
    }),
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
    ragContext({ corpus: 'billing-docs', query: (t) => t.userMessage ?? '' }),
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
import { defineChat, ragContext, staticContext } from '@plumbus/chat';
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
    staticContext({
      id: 'nav-surfaces',
      sourceId: 'product-nav',
      items: [
        { id: 'nav.project', kind: 'text', content: 'Project page' },
        { id: 'nav.timeline', kind: 'text', content: 'Timeline page' },
      ],
    }),
    ragContext({
      id: 'docs',
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage ?? '',
      topK: 6,
      filter: (turnCtx) => ({
        audience: turnCtx.audience,
        locale: turnCtx.locale,
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
import { registerChatRoutes } from '@plumbus/chat';
import { helpChat } from './chats/help.chat.js';

export function onRoutesRegistered(app, routeConfig) {
  registerChatRoutes(app, routeConfig, [helpChat]);
}

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
