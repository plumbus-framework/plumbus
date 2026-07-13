# Locale required on every turn

> **Locked.** `TurnContext.locale` is mandatory.

## The problem

Multi-locale apps (e.g. MemoirAI ships EN + HE with RTL) hit recurring problems when chat is locale-unaware:

- The model replies in the wrong language for the user.
- Surface names ("Project" vs "פרויקט") get mixed within a single reply.
- Locale-tagged knowledge chunks don't get filtered by language and the model receives mixed-locale context.
- Runtime-emitted notice text (cooldown messages, refusal copy) is always in English.

The published spec mentions locale only under "future considerations." Without making it first-class, every consumer hits the same drift between chat code and `app/translations/` catalogs.

## How it works

`TurnContext.locale` is a required field, threaded everywhere:

```ts
interface TurnContext {
  // ...
  locale: string;              // e.g. 'en', 'he'
}
```

It threads to:

1. **Context-source filters** — sources can filter RAG chunks, capability inputs, or static items by `turnCtx.locale`.
2. **`locale-guard` (pre-turn)** — if `policy.scope.locales` is set, the guard normalizes `turnCtx.locale` against the whitelist and blocks unsupported locales.
3. **Prompt anchor** — `buildSystemPrompt` inserts `[Reply in '{locale}' only. No mixed-language responses.]` near the user message.
4. **`policy.reply.locale`** — when `'auto'` (default), reply locale = turn locale. When a specific locale is set, that wins (e.g. `reply.locale: 'en'` forces English replies regardless of turn locale).
5. **`ctx.translations.resolver(locale)`** — runtime-emitted notice strings (cooldown messages, refusal copy) are resolved through translations rather than hardcoded.

## Tradeoffs

**What works well:**
- Single source of truth for "what language is this conversation in." Every layer sees the same value.
- `staticContextFromTranslations` becomes useful — items are pulled from the active locale's catalog, no drift.
- Notice text follows the user's language by default.

**What you give up:**
- Turn calls must include locale. Server-persistence chats can default to the session's stored locale; client-persistence chats must pass it on every request.
- Locale strings are uninterpreted — the runtime does not enforce ISO codes. Apps can use whatever scheme their translations use, but mixing schemes across consumers will hurt.

## Footgun

If a consumer passes `locale: 'en'` to a chat whose underlying RAG corpus only has Hebrew chunks, the model will struggle. The corpus filter needs to handle this — either fall back to all locales or expose the gap as a notice.

---

## Addendum (2026-07-08) — C9 `policy.reply.locale`

**Implemented:** `runChatTurn` passes `replyLocale: policy.reply?.locale` into `buildSystemPrompt`. `'auto'` (default) uses `turnCtx.locale`; a concrete `reply.locale` forces that language in the `[Reply in '…' only.]` anchor.

**Partial:** Runtime notice strings remain mostly hardcoded English. Only the out-of-scope refusal notice resolves through `ctx.translations` today.
