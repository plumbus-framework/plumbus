# Audience as a first-class policy slot

> **Locked.** Default `mode: 'strict'`.

## The problem

Help-style chats often serve multiple audiences with different surface vocabulary, different access patterns, and different appropriate knowledge: a user-app help-bot answers about onboarding and self-serve features; an admin-panel help-bot answers about workflows, billing reconciliation, and audit. Both might share a single chat config in code, but the *answers* must differ by caller role.

The published spec has `privacy.boundary: "authenticated_subject"` — a binary auth check. It does not have a first-class concept of role or audience. Without one, every consumer with a multi-audience chat reinvents the same ad-hoc pattern in custom guards, with predictable inconsistencies.

## How it works

`policy.audience` is a top-level slot:

```ts
policy: {
  audience: {
    roles: string[];                         // allowed caller roles
    default?: string;                        // for permissive mode
    mode?: 'strict' | 'permissive';          // default 'strict'
  }
}
```

It threads to three places at runtime:

1. **`audience-guard` (pre-turn)** — checks `ctx.security.hasRole(role)` against `policy.audience.roles`. In strict mode, missing role → `block` with `notice: chat.audience_denied` on the wire (the verdict's internal `reason` is `audience_mismatch`, but the notice code consumers see is `chat.audience_denied`). In permissive mode, the turn proceeds with `audience = policy.audience.default ?? 'unknown'`.
2. **Context-source filters** — `TurnContext.audience` is available to every context source's `filter(turnCtx)`, so admin-only RAG chunks don't get served to user calls. `knowledgeContext` auto-attaches `({ audience }) => ({ audience })` when no filter is provided and `policy.audience` is set.
3. **Prompt anchor** — `buildSystemPrompt` inserts an `[Audience: {audience}]` line near the user message. The model uses it to pick audience-appropriate surfaces in its answer.

Default `mode: 'strict'` because the wrong default is dangerous — admin docs leaking to a user is worse than a permissive chat being too restrictive.

## Tradeoffs

**What works well:**
- One declaration in `defineChat` instead of three coordinated implementations in custom guards.
- Multi-audience chats can share a single config; only context-source filters need per-audience logic.
- The default-filter auto-attach on `knowledgeContext` prevents the most common leak pattern.

**What you give up:**
- Consumer apps with no meaningful audience distinction still need to declare one. `policy.audience: { roles: ['user'] }` is fine.
- Hybrid public/authenticated chats are slightly awkward — they need `mode: 'permissive'` plus a sensible `default`.

## Out of scope

More granular audience expressions (permission strings, tenant attributes, custom claim shapes) are not built in. If they prove needed, extend the slot rather than rolling another guard pattern.

---

## Addendum (2026-07-08) — C10 audience auto-filter

When `policy.audience` is present, `runChatTurn` sets `turnCtx.applyDefaultAudienceFilter: true`. Each `ragContext` without an explicit `filter` then passes `{ audience: turnCtx.audience }` into `ctx.ai.retrieve` (one-time console warning per source id). Opt out per source with `parentChatAudiencePolicy: false`.

Registry `knowledgeContext` does not auto-attach retrieve filters — scope flows via `scopeFromTurn` into KB providers instead.

**Still not implemented:** permissive-mode substitution of `policy.audience.default` into `turnCtx.audience`; callers still supply the audience string on each turn.
