# Defining Chats — Agent Recipe

When the user asks you to add a new chat to a Plumbus app, follow this recipe.

## Step-by-step

1. **Pick a name.** camelCase, one word per concept. Examples: `helpChat`, `billingChat`, `supportChat`.
2. **Create one file per chat** under `app/chats/<name>.chat.ts`. One `defineChat` per file. Export the result.
3. **Always include `access`** — the standard Plumbus AccessPolicy. Most chats want `{ roles: ['user'] }` or `{ roles: ['user', 'admin'] }`.
4. **Decide persistence mode explicitly.** Default is `'server'`. Choose `'client'` if privacy matters or the chat is throwaway.
5. **Pick at least one context source.** Empty context is allowed but warns. Pure-model chats are rare.
6. **Always declare `policy.audience`** if the app has multi-role users. Strict by default.
7. **Set budgets.** Real production chats need at minimum `perSession.userMessages` and `perUser.turnsPerDay`.
8. **Register the chat's entities** in the app's entity boot (`chatSessionEntity`, `chatTurnEntity`, `chatPendingActionEntity`).
9. **Register HTTP routes** via `registerChatRoutes(app, routeConfig, [helpChat, billingChat, ...])` in the app's `onRoutesRegistered` hook.
10. **Mount the UI** with `<ChatPanel chatName="help" sessionId={s} audience={...} locale={...} />`.

## Minimal Recipe

```ts
// app/chats/help.chat.ts
import { defineChat, knowledgeContext } from '@plumbus/chat';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  instructions: [
    'You are the help assistant for ProductX.',
    'You DO NOT perform actions on behalf of the user.',
  ],
  context: [
    knowledgeContext({
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage,
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
    action?:   { allowedCapabilities: string[] },
    custom?:   Guard[],
  },

  budget?: {
    perTurn?:    { tokens?, costUsd? },
    perSession?: { turns?, userMessages?, tokens?, costUsd? },
    perUser?:    { turnsPerHour?, turnsPerDay?, costUsdPerDay? },
    perTenant?:  { costUsdPerDay? },
    contextTokens?: number,
    actions?:    { perSession? },
    timeout?:    { perTurnSeconds? },
  },

  history?: {
    includeLastTurns?: number,               // default 8
    summarize?: { strategy, thresholdTurns?, targetTokens? },
  },

  persistence?: { messageContent: 'server' | 'client' },  // default 'server'

  exposeAs?: 'sse' | 'capability' | 'both',  // default 'sse'

  prompt?: PromptDefinition,                 // optional per-chat prompt
});
```

## Do's

- **Do** put one `defineChat` per file under `app/chats/<name>.chat.ts`.
- **Do** include `instructions` even if short — the framework joins them into the system prompt body.
- **Do** use `staticContextFromTranslations` when surface names already exist in `app/translations/`. Manual `staticContext` copies will drift.
- **Do** set `policy.audience` with all roles that should access the chat, even single-role chats (`['user']`).
- **Do** set `budget.perSession.userMessages` on every chat — prevents runaway conversations.
- **Do** pass `locale` explicitly to every turn. Server-persistence chats can default from the session row; client-persistence must pass on every request.
- **Do** register chat entities exactly once at app boot, alongside the app's own entities.

## Don'ts

- **Don't** put structured data in `instructions: [...]`. Use `staticContext` instead — it gets provenance handles and budget accounting.
- **Don't** use a write-effect capability as `capabilityContext`. The framework rejects this at construction time; use `actions:` + `policy.action.allowedCapabilities` for writes.
- **Don't** narrow the prompt output schema when using `defineChat({ prompt })`. The five base fields (`inScope`, `answer`, `refusalReason`, `citedSources`, `requestedAction`) are required by runtime guards. Extra fields are fine.
- **Don't** call `runChatTurn` directly from your route handlers. Use `registerChatRoutes(app, routeConfig, chats)` — it wires auth, body validation, SSE, and `clientHistory` capping correctly.
- **Don't** hand-write SSE event names. The protocol is `turn.started`, `source.added`, `notice`, `message.delta`, `confirmation_required`, `turn.completed`, `turn.failed` — defined in `src/types/event.ts`.
- **Don't** invent source IDs. The resolver issues handles in source-declaration order (`src_a`, `src_b`, ...). Cite using exactly those strings.

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
