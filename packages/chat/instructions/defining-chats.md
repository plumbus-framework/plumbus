# Defining Chats — Agent Recipe

When the user asks you to add a new chat to a Plumbus app, follow this recipe.

## Step-by-step

1. **Pick a name.** camelCase, one word per concept. Examples: `helpChat`, `billingChat`, `supportChat`.
2. **Create one file per chat** under `app/chats/<name>.chat.ts`. One `defineChat` per file. Export the result.
3. **Always include `access`** — the standard Plumbus AccessPolicy. Most chats want `{ roles: ['user'] }` or `{ roles: ['user', 'admin'] }`.
4. **Decide persistence mode explicitly.** Default is `'server'`. Choose `'client'` if privacy matters or the chat is throwaway.
5. **Pick at least one context source.** Empty context is allowed but warns. Pure-model chats are rare.
6. **Always declare `policy.audience`** if the app has multi-role users. Strict by default.
7. **Set budgets.** Real production chats need at minimum `perSession.userMessages` (DB-backed or ephemeral) and `perUser.turnsPerDay` when `saveToDb: true`.
8. **Register the chat's entities** in the app's entity boot (`chatSessionEntity`, `chatTurnEntity`, `chatPendingActionEntity`).
9. **Register HTTP routes** via `registerChatRoutes(app, routeConfig, [helpChat, billingChat, ...])` in the app's `onRoutesRegistered` hook.
10. **Mount the UI** with `<ChatPanel chatName="help" sessionId={s} audience={...} locale={...} turnUrl="/api/chat/help/turn" />`. The `turnUrl` is optional; omit it when the server is mounted at the default `/chat/:name/turn`.

## Minimal Recipe

```ts
// app/chats/help.chat.ts
import { defineChat, ragContext } from '@plumbus/chat';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  instructions: [
    'You are the help assistant for ProductX.',
    'You DO NOT perform actions on behalf of the user.',
  ],
  context: [
    ragContext({
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage ?? '',
    }),
  ],
  policy: {
    audience: { roles: ['user'], mode: 'strict' },
    scope: { description: 'Help with ProductX product usage only.' },
  },
  budget: {
    perSession: { userMessages: 35 },
    perUser: { turnsPerDay: 200 },
  },
});
```

## Full Config Shape

```ts
defineChat({
  name: 'billingChat',                       // REQUIRED — unique within app, camelCase
  description?: 'short description',         // optional, for docs / admin UI

  access: { roles: ['user'], tenantScoped: true },  // REQUIRED

  instructions?: string[],                   // joined with \n into the system prompt
  context?: ContextSource[],                 // see context-sources.md
  actions?: string[],                        // capability names enabled for action-guard

  policy?: {
    audience?: { roles, default?, mode: 'strict' | 'permissive' },
    scope?:    { description?, classifier?: 'inline', locales?: string[] },
    reply?:    { locale: 'auto' | string },
    privacy?:  { redact: string[] },
    provenance?: { required: boolean, minSources?: number },
    behavioral?: { cooldowns: Cooldown[] },
    action?:   { allowedCapabilities: string[], frameworkExecuteOnConfirm?: boolean }, // Path A; default false (decision-only)
    toolCalling?: {                                    // Path B — provider-native tool calling
      enabled: true,
      capabilities?: string[],
      autoStartFlows?: string[],
      maxToolRounds?: number,                          // default 5, range 1..20
    },
    custom?:   Guard[],
  },

  budget?: {
    perTurn?:    { tokens?, costUsd? },       // enforced post-generation
    perSession?: { turns?, userMessages?, tokens?, costUsd? },  // pre-turn; userMessages also in ephemeral mode
    perUser?:    { turnsPerHour?, turnsPerDay?, costUsdPerDay? },
    perTenant?:  { costUsdPerDay? },
    contextTokens?: number,
    actions?:    { perSession? },             // enforced in action-guard
    timeout?:    { perTurnSeconds? },
  },

  history?: {
    includeLastTurns?: number,               // default 8
    summarize?: { strategy, thresholdTurns?, targetTokens? },
  },

  persistence?: {
    messageContent: 'server' | 'client',     // default 'server'
    saveToDb?: boolean,                      // default true — see below
  },

  exposeAs?: 'sse' | 'capability' | 'both',  // default 'sse'
  streaming?: boolean,                       // default true (SSE); false → JSON request/response

  prompt?: PromptDefinition,                 // optional per-chat prompt
});
```

### `persistence.saveToDb`

Two independent knobs. `messageContent` controls where the prose lives; `saveToDb` controls whether the runtime writes to `chat_session` / `chat_turn` / `chat_pending_action` at all.

- `saveToDb: true` (default) — full audit, cross-device continuity, action confirmation, server-authoritative state.
- `saveToDb: false` — no chat-table writes. The client owns `sessionId`; cooldowns and per-session message caps are enforced from `clientHistory` (assistant messages carry their `refusalReason` on the wire). `defineChat` rejects three combinations: `saveToDb: false` + `messageContent: 'server'`, `saveToDb: false` + `policy.action.allowedCapabilities`, and `saveToDb: false` + `policy.toolCalling.enabled` (tool execution records require `chat_turn` rows). Action confirmation and Path B tool calling are therefore unavailable in ephemeral mode.

### `streaming`

When `streaming: false`, `registerChatRoutes` registers a JSON request/response route at the same path instead of SSE. Use for server-to-server callers that can't consume an event stream.

### `registerChatRoutes(app, routeConfig, chats, opts?)`

The optional fourth argument is `RegisterChatRoutesOpts`:

| Option | When to use |
|---|---|
| `authCookieNames: string[]` | Browser callers carry the session token in a cookie rather than `Authorization`. First non-empty cookie wins; it becomes `Bearer <value>`. |
| `chatRegistry: ChatRegistry` | **Required for `policy.toolCalling` (Path B) chats.** Build with `createChatRegistry(promptRegistry)`; supplies the `chat.toolRound` / `chat.scopeCheck` prompt-registration status Path B checks. Pass alongside the transactional `store`. |
| `audienceTenantOverride: (audience, auth) => tenantId \| undefined` | Audience-implied tenant routing when the auth adapter couldn't infer one. Only applied when `auth.tenantId` is empty. |
| `beforeTurn: (ctx, parsed, rawBody) => { userMessage? } \| { error: { status, body } }` | Sanitize the user message or short-circuit with a typed error before any runtime work. |
| `afterTurn: (ctx, rawBody, events) => Promise<void>` | Observability hook. Receives the full ordered `ChatEvent[]` after the turn completes. Errors are swallowed with `console.warn`. |

### `<ChatPanel turnUrl=… />`

When the server-side route is namespaced (`/api/chat/...`), pass `turnUrl` on the panel so the hook posts there instead of the default `/chat/:name/turn`.

## Do's

- **Do** put one `defineChat` per file under `app/chats/<name>.chat.ts`.
- **Do** include `instructions` even if short — the framework joins them into the system prompt body.
- **Do** use `@plumbus/knowledge-base` `translationCatalog` + registry `knowledgeContext` when surface names live in `app/translations/`. `staticContextFromTranslations` is deprecated and resolves nothing unless you pass `getCatalog`.
- **Do** set `policy.audience` with all roles that should access the chat, even single-role chats (`['user']`).
- **Do** set `budget.perSession.userMessages` on every chat — enforced in DB mode via `checkBudgetPreflight` and in ephemeral mode via `clientHistory` counting. Budget knobs are hard limits when set (not advisory, not behind an enforce flag): unset or raise any limit you do not want enforced.
- **Do** pass `locale` explicitly to every turn. Server-persistence chats can default from the session row; client-persistence must pass on every request.
- **Do** register chat entities exactly once at app boot, alongside the app's own entities.

## Don'ts

- **Don't** put structured data in `instructions: [...]`. Use `staticContext` instead — it gets provenance handles and budget accounting.
- **Don't** use a write-effect capability as `capabilityContext`. The framework rejects this at construction time; use `actions:` + `policy.action.allowedCapabilities` for writes.
- **Don't** narrow the prompt output schema when using `defineChat({ prompt })`. The five base fields (`inScope`, `answer`, `refusalReason`, `citedSources`, `requestedAction`) are required by runtime guards. Extra fields are fine.
- **Don't** call `runChatTurn` directly from your route handlers. Use `registerChatRoutes(app, routeConfig, chats)` — it wires auth, body validation, SSE, and `clientHistory` capping correctly.
- **Don't** hand-write SSE event names. The protocol is `turn.started`, `source.added`, `notice`, `message.delta`, `confirmation_required`, `turn.completed`, `turn.failed` — defined in `src/types/event.ts`.
- **Don't** invent source IDs. The resolver issues handles in source-declaration order (`src_a`, `src_b`, ...). Cite using exactly those strings.
- **Don't** set speculative budget caps expecting silent no-ops — `perTurn`, `perSession.userMessages`, `actions.perSession`, and `provenance.minSources` are enforced at runtime.

## Common Workflows

### Add a chat to an existing app

```bash
# 1. Create the chat file
mkdir -p app/chats
touch app/chats/help.chat.ts

# 2. (one-time) Register chat entities in app boot
#    Add to app/entities/index.ts or wherever entities are registered:
#      import { chatSessionEntity, chatTurnEntity, chatPendingActionEntity } from '@plumbus/chat';

# 3. (one-time) Register chat routes in the server bootstrap
#    Inside onRoutesRegistered:
#      registerChatRoutes(app, routeConfig, [helpChat, billingChat]);

# 4. (one-time) Generate Drizzle migration for the chat entities
pnpm migrate:generate

# 5. Apply migration
pnpm migrate:apply
```

### Add a per-chat prompt with admin AI Config override

```ts
// app/prompts/help-bot.prompt.ts
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const helpBotPrompt = definePrompt({
  name: 'help.chat',
  domain: 'support',
  description: `... 200-line system body ...`,
  input: z.object({ systemPrompt: z.string(), userMessage: z.string() }),
  output: z.object({
    inScope: z.boolean(),
    answer: z.string(),
    refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
    citedSources: z.array(z.string()),
    requestedAction: z.unknown().nullable(),
    // extras allowed:
    suggestedNextStep: z.string().optional(),
  }),
  model: { temperature: 0.3, maxTokens: 800 },
});

// app/chats/help.chat.ts
import { helpBotPrompt } from '../prompts/help-bot.prompt.js';
export const helpChat = defineChat({
  name: 'help',
  // ...
  prompt: helpBotPrompt,
});
```

### Enable provider-native tool calling (Path B)

Path B needs two one-time app setup steps — (a) re-export the prompts and (b) wire a
`ChatRegistry` into `registerChatRoutes` — plus a transactional store.

1. **(a) Re-export the tool-calling prompts into `app/prompts/`** so directory discovery
   registers them (same one-time wiring as `chat.turn`). Missing prompts fail on the first
   Path B turn — a per-turn `turn.failed` carrying `chat.prompt_not_registered`, not a
   boot-time error.

   ```ts
   // app/prompts/chat-tool-round.prompt.ts
   export { chatToolRoundPrompt } from '@plumbus/chat';

   // app/prompts/chat-scope-check.prompt.ts
   export { chatScopeCheckPrompt } from '@plumbus/chat';
   ```

2. **(b) Build a `ChatRegistry` and pass it as `chatRegistry`** in the `registerChatRoutes`
   opts, alongside the transactional store. This is what lets Path B check that the two
   prompts above are registered.

   ```ts
   import { createChatRegistry, registerChatRoutes } from '@plumbus/chat';

   // promptRegistry is the runtime PromptRegistry (any object with has(name))
   const chatRegistry = createChatRegistry(promptRegistry);
   registerChatRoutes(app, routeConfig, [supportChat], { store, chatRegistry });
   ```

3. **Turn on `policy.toolCalling`** and list capabilities / flows.

   ```ts
   export const supportChat = defineChat({
     name: 'support',
     access: { roles: ['user'] },
     policy: {
       toolCalling: {
         enabled: true,
         capabilities: ['lookupOrder', 'openSupportTicket'],
         autoStartFlows: ['issueRefund'],   // bound as flow__issueRefund (flow name <= 57 chars)
         maxToolRounds: 5,
       },
     },
   });
   ```

4. **Use a transactional store.** Path B needs the lease-based `ChatConversationStore`;
   a non-transactional adapter fails closed with `chat.storage_unsupported`.
   Confirm-mode tools commit via `POST /chat/:name/confirm`, which the client's
   `useChat.confirm()` calls automatically.

### Add a refusal cooldown

```ts
policy: {
  behavioral: {
    cooldowns: [
      { trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' },
    ],
  },
},
```

After 3 in-session refusals, the chat blocks for 30 seconds, emitting `notice: chat.cooldown_active` with `retryAfterSeconds`.

## Deeper Reference

- `/docs/chat/defining-chats.md` — full conceptual reference
- `/docs/chat/design/per-chat-prompts.md` — why `prompt:` exists
- `/docs/chat/design/message-persistence-modes.md` — persistence tradeoffs
- `src/define/defineChat.ts` — the validation schema (read this before adding new config fields)
