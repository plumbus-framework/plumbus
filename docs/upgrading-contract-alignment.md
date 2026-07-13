# Upgrading for contract alignment

This checklist covers **runtime behavior changes** shipped to align the framework with documented contracts. API shapes, install peers, and wire formats are unchanged unless noted elsewhere.

Hard install/compile/wire/data breaks are avoided in this pass. What remains is **same inputs, different outcomes** for apps that relied on undocumented gaps.

## Migration stance (locked)

Plumbus keeps **contract-first defaults**. There is **no** framework-wide “legacy mode” and no plan to flip Breaking defaults off for compatibility.

| Decision | Rationale |
|----------|-----------|
| Transactional outbox **default ON** | Matches the outbox design decision; opt-out hatches exist for specific apps |
| Chat budget / audience knobs **enforce when set** | Documented knobs mean what they say; unset = unlimited / no auto-filter |
| `plumbus api validate` governance **advisory** | Same model as `plumbus verify`; use `--fail-on-governance` in CI if you want a gate |
| AI prompt security **opt-in** | No scan without `aiProviders.security` / `AI_SECURITY_*` |

**For existing apps:** use the escape hatch in each row below (or unset speculative chat budget knobs), verify staging, then prefer returning to the recommended defaults. Do not ask the framework to permanently dual-track soft vs strict runtime.

## Register overview

| # | Class | Area | Escape hatch |
|---|-------|------|--------------|
| 1 | Breaking behavior | Transactional writes default ON (A1) | `execution.transactionalOutbox: false`; per-capability `transactional: false`; AI/job/external auto-excluded |
| 2 | Breaking behavior | `plumbus api validate` governance advisory-only (A4) | `--fail-on-governance` |
| 3 | Behavior fix | `maskedInLogs` in structured log metadata (A18) | Custom logger without `maskKeys`; omit sensitive keys from metadata |
| 12 | Breaking behavior | AI security `mode: block` aborts classified prompt input (A2) | `aiProviders.security.mode: 'redact'` (default when configured) or omit `security` |
| 13 | Added | Field encryption at rest for `encrypted: true` fields (A3) | Omit `PLUMBUS_ENCRYPTION_KEY`; legacy plaintext rows still readable |
| 14 | Added | Encrypted fields cannot be filtered/sorted by column (A3) | Do not filter, `orderBy`, or date-filter on `encrypted: true` fields; decrypt in app code |
| 15 | Behavior fix | Nested invoke audit includes `caller` (A1) | Additive metadata only |
| 16 | Behavior fix | Chat action decline is idempotent (C6) | No change — safe to retry `execute: false` |
| 17 | Behavior fix | Context resolver timeout warns on skip (C12) | Tune `contextResolution.perSourceTimeoutMs` or fix slow sources |
| 18 | Added | Per-request locale on HTTP/MCP routes (A17) | Static `defaultLocale` only if headers/cookie absent |
| 19 | Behavior fix | One-time warn when AI capability runs inside open transaction | Keep AI calls outside transactional handlers or accept longer tx hold |
| 20 | Behavior fix | HTTP capability emits restore dynamic `causationId` | Additive — outbox rows now attribute to executing capability |
| 4 | Breaking behavior | Chat budget knobs enforced (C7) | Unset or raise limits |
| 5 | Breaking behavior | Audience auto-filter on `ragContext` (C10) | `parentChatAudiencePolicy: false` |
| 6 | Behavior fix | Behavioral cooldowns honored (C8) | Remove or loosen cooldown config |
| 7 | Behavior fix | Action-confirm schema hash v2 (C6) | Legacy pending rows keep old path |
| 8 | Behavior fix | `policy.reply.locale` in system prompt (C9) | Omit or set `reply.locale: 'auto'` |
| 9 | Behavior fix | KB source-level `ranker` invoked (K13) | Provider-level ranker still wins |
| 10 | Behavior fix | `mockKnowledgeSource` stores `scope` (K14) | Additive metadata only |
| 11 | Behavior fix | KB forbidden-import CI test (K15) | N/A — framework test only |

Items below are filled in as each change lands. Start here if you use CI `plumbus api validate` as a governance gate.

---

## 1. Transactional outbox default ON (A1)

### Am I affected?

Your `action` or `eventHandler` capabilities write to the database **and** emit events via `ctx.events.emit()`, and you relied on partial commits (entity row persisted but outbox row missing after a handler failure, or the reverse).

### What changed

Handler execution and output validation for `action` and `eventHandler` capabilities now run inside a single Drizzle transaction. `ctx.data.*` writes and `ctx.events.emit()` outbox inserts share the same transaction and roll back together on handler errors or invalid output. Capability success audit rows still record on the outer database connection after commit.

Auto-excluded (unchanged non-transactional behavior):

- `kind: 'job'`
- `effects.ai: true`
- `effects.external` (non-empty `effects.external` array)
- `kind: 'query'` (and other kinds)

Nested `ctx.capabilities.invoke` calls reuse the parent transaction when the callee is also transactional. `ctx.flows.start()` and `ctx.jobs.enqueue()` inside a transaction defer until after commit. `enqueue` returns a pre-allocated job id immediately; the queue write runs after commit. `flows.start` returns a placeholder execution handle with `status: 'pending'` until the real row is created post-commit.

Nested success capability audits defer until parent commit; nested failure audits record immediately. The first nested invoke of an `effects.ai: true` capability inside an active transaction emits a one-time `ctx.logger.warn` that the parent transaction is held open for the LLM call.

### Migration

- **Keep new behavior (recommended):** no change — verify integration tests / staging flows that combine writes + emits.
- **Disable globally:** set `execution.transactionalOutbox: false` in config or `PLUMBUS_TRANSACTIONAL_OUTBOX=false`.
- **Disable per capability:** add `transactional: false` to `defineCapability({ ... })`.
- **Parents that invoke AI capabilities:** prefer `transactional: false` on the parent action, or accept the one-time warn and longer transaction hold.

```typescript
// plumbus.config.ts or loadConfig merge
export default {
  execution: { transactionalOutbox: false },
};

// Per capability
defineCapability({
  name: 'legacyAction',
  kind: 'action',
  transactional: false,
  // ...
});
```

---

## 2. `plumbus api validate` and governance signals (A4)

### Am I affected?

Your CI runs `plumbus api validate` and treats **any** stderr warning as failure — including governance rule IDs such as `api.missing-auth` or architecture signals — even when manifest/policy/path/fixture checks pass.

### What changed

The command exits `1` only on hard contract findings (manifest, policy, path params, fixtures). Governance rule signals are printed but no longer fail the command unless you pass `--fail-on-governance`.

### Migration

- **Keep advisory governance in CI:** no change.
- **Restore strict gate:** add `--fail-on-governance` to your CI invocation.

---

## 3. Structured log metadata masking (A18)

### Am I affected?

Your capability handlers log entity field values via `ctx.logger.info(..., { email, token, ... })` and you rely on those values appearing in structured logs or log aggregators.

### What changed

Request-scoped loggers built by server/MCP bootstrap collect masked field names from the entity registry (`maskedInLogs: true`, or classification `personal` / `sensitive` / `highly_sensitive`). Matching metadata keys are replaced with `***MASKED***` before emit, including nested keys inside metadata objects.

Repository mutation audit payloads (`audit_records`) use a separate deep mask with token `***` (not `***MASKED***`).

### Migration

- Mark sensitive fields with `maskedInLogs: true` (or appropriate classification) on entity definitions.
- Pass a custom `logger` on `ServerConfig` without `maskKeys` if you intentionally need unredacted metadata in a controlled environment.

---

## 12. AI security mode: block vs redact (A2)

### Am I affected?

You pass entity-shaped data into `ctx.ai.generate()` / `streamGenerate()` and rely on highly sensitive fields being redacted while the call still proceeds — **or** you set `AI_SECURITY_MODE=block` expecting hard failure.

### What changed

`aiProviders.security` must be present in config (or env vars below) for classified-field scanning to run. When configured, `mode` controls runtime behavior (default **`redact`**):

| Mode | Behavior |
|------|----------|
| `redact` | Warn at `warnThreshold`; replace fields at/above `redactThreshold` with `[REDACTED]` and continue |
| `block` | Abort the AI call when any field at/above `warnThreshold` is detected |

Entity definitions are auto-populated from the entity registry when the `security` block is set.

### Migration

- **Disable scanning:** omit `aiProviders.security` entirely (legacy behavior — no field scan).
- Keep redaction (default when configured): set `security: { mode: 'redact' }` or rely on env defaults.
- Block classified data: set `aiProviders.security.mode: 'block'` or `AI_SECURITY_MODE=block`.
- Tune thresholds: `warnThreshold` / `redactThreshold` on `AISecurityConfig`, or `AI_SECURITY_WARN_THRESHOLD` / `AI_SECURITY_REDACT_THRESHOLD` env vars.

---

## 13. Field encryption at rest (A3)

### Am I affected?

You define `encrypted: true` on entity string fields and expect ciphertext in PostgreSQL.

### What changed

When `PLUMBUS_ENCRYPTION_KEY` is set (32-byte hex or base64), repositories encrypt `encrypted: true` string fields on create/update and decrypt on read. Values without the `plumbus:enc:v1:` prefix are returned as-is (plaintext fallback for legacy rows).

### Migration

- Generate a 32-byte key: `openssl rand -hex 32`
- Set `PLUMBUS_ENCRYPTION_KEY` in all API, worker, and flow-runner processes.
- Re-save existing rows to encrypt legacy plaintext, or run a one-off migration.

---

## 14. Encrypted field query guard (A3)

### Am I affected?

You filter repository queries on string fields marked `encrypted: true` while `PLUMBUS_ENCRYPTION_KEY` is set.

### What changed

Repositories throw `DataValidationError` when a `findMany` filter, `orderBy`, `dateFilters`, `in`/`notEq`, or `search` targets an encrypted string field — ciphertext is not searchable or meaningfully sortable at the SQL layer.

### Migration

- Query by non-encrypted keys (ids, foreign keys) and decrypt in application code after read.
- Do not add indexes, `WHERE`, `ORDER BY`, or date-range clauses on encrypted columns.
- Sort in application code after decrypt when needed.

---

## 15. Nested capability audit metadata (A1)

### Am I affected?

You parse capability audit rows and did not expect a `caller` field on nested `ctx.capabilities.invoke` executions.

### What changed

Success audit metadata for nested invocations includes `caller` set to the invoking capability's canonical name. Nested success audits defer until parent commit; failure audits record immediately. HTTP capability routes restore dynamic `causationId` on `ctx.events.emit()` from the executing capability (nested invokes attribute to the immediate caller).

### Migration

No action required unless downstream audit consumers assume a fixed metadata shape — allow optional `caller`.

---

## 16. Idempotent chat action decline (C6)

### Am I affected?

Clients call `chatConfirmAction` with `execute: false` more than once, or after a pending row was already rejected/expired.

### What changed

`rejectPending` returns successfully when the row is already `rejected` or `expired`, or when the row is missing — duplicate declines no longer surface as errors.

### Migration

None. Safe to retry decline UX without custom deduplication.

---

## 17. Context resolver timeout warnings (C12)

### Am I affected?

You operate chats with slow context sources and rely on logs/metrics to detect hung resolvers.

### What changed

Per-source timeout (default 5s, overridable via `contextResolution.perSourceTimeoutMs` on the chat definition) skips slow sources when `onError: 'skip'`. Skipped sources emit `ctx.logger.warn` with `sourceId` and `perSourceTimeoutMs`.

### Migration

- Tune `contextResolution.perSourceTimeoutMs` on `defineChat` if 5s is too aggressive.
- Fix or cache slow sources; set `onError: 'fail'` during development to surface errors immediately.

---

## 18. Per-request locale on HTTP routes (A17)

### Am I affected?

You serve localized HTTP/MCP capability responses and relied on a static `defaultLocale` only.

### What changed

`resolveRequestLocale()` reads `plumbus-ui-locale` cookie then `Accept-Language` (higher `q` values later in the header win). Resolved locale is passed into `ctx.translations` per request.

### Migration

- No change if you already send `Accept-Language` or the cookie.
- Override with explicit locale handling in handlers if you need a different policy.

---

## 4. Chat budget knobs enforced (C7)

### Am I affected?

You set `budget.perTurn`, `budget.perSession.userMessages`, `budget.actions.perSession`, or `policy.provenance.minSources` expecting advisory-only behavior.

### What changed

- `perTurn.tokens` / `perTurn.costUsd` — enforced after generation; breach emits `chat.budget_exceeded` and `turn.failed`, persists user + assistant turns when DB mode is on.
- `perSession.userMessages` — enforced in DB mode via `checkBudgetPreflight`.
- `actions.perSession` — pending-action cap enforced by `action-guard` (`action_budget_exceeded`).
- `provenance.minSources` — enforced post-turn by `provenance-guard`.

Ephemeral (client-history) `userMessages` cap behavior is unchanged.

### Migration

Unset knobs you added speculatively, or raise limits to match product needs.

---

## 5. Audience auto-filter on `ragContext` (C10)

### Am I affected?

You use `ragContext({ corpus, query })` without an explicit `filter` and did not expect retrieve metadata to include audience.

### What changed

When the chat has `policy.audience` set, `runChatTurn` sets `turnCtx.applyDefaultAudienceFilter: true`. `ragContext` then applies `{ audience: turnCtx.audience }` unless you pass an explicit `filter` or set `parentChatAudiencePolicy: false`.

### Migration

- **Want the filter:** do nothing, or add an explicit `filter` that includes audience (and locale if needed).
- **Need unfiltered corpus:** `ragContext({ …, parentChatAudiencePolicy: false })` or `filter: () => ({})`.

Registry `knowledgeContext` is unchanged — scope still flows via `scopeFromTurn`.

---

## 6. Behavioral cooldowns honored (C8)

### Am I affected?

You configured `policy.behavioral.cooldowns` with `windowSeconds`, `guardFailure`, `budget`, or `scope: 'user'` and expected them to fire — but they never did (or fired on every turn).

### What changed

- `windowSeconds` implements sliding windows before `count` is evaluated.
- `guardFailure` and `budget` triggers increment when the matching signal fired — post-turn guard blocks, or pre-turn guard blocks (before the model runs).
- User-scoped keys use `user:{userId}` and merge only `*:user:*` behavioral keys from the caller's recent sessions (up to 50 rows). Fresher cross-session user keys override stale copies on the current session row so alternating sessions cannot defeat `scope: 'user'` cooldowns. Session-scoped keys from other sessions do not bleed.

Counters remain read-modify-write (not `UPDATE … RETURNING`).

### Migration

- Re-tune `count` / `durationSeconds` if cooldowns now feel aggressive.
- Remove cooldown rules you added speculatively if you do not want enforcement.

---

## 7. Action-confirm schema hash v2 (C6)

### Am I affected?

You ship action confirmation with `policy.action.allowedCapabilities` and/or store pending actions across deploys.

### What changed

Pending actions store `v2:` + sha256 of capability input schema **and** proposed payload via `ctx.capabilities.describe`. Confirm rejects drift with `chat.action_schema_changed` (re-derived hash). Echo mismatch on the wire hash uses `chat.action_schema_mismatch`. Legacy unprefixed hashes keep echo-compare only. Invalid propose-time input is blocked with `chat.action_input_invalid`. Decline is idempotent for missing/already-rejected/expired rows.

### Migration

- Re-propose actions after schema changes.
- Clients should handle `chat.action_schema_changed` and `chat.action_schema_mismatch` distinctly.

---

## 8. `policy.reply.locale` in system prompt (C9)

### Am I affected?

You set `policy.reply.locale` expecting the model to honor a forced reply language.

### What changed

`buildSystemPrompt` threads `replyLocale` into the language anchor (`auto` falls back to turn locale).

### Migration

Omit `reply.locale` or set `'auto'` for turn-locale behavior.

---

## 9. KB source-level `ranker` invoked (K13)

### Am I affected?

You set `ranker` on `defineKnowledgeSource` expecting custom ordering when the provider factory does not supply its own ranker.

### What changed

Precedence is provider-factory explicit ranker → `defineKnowledgeSource({ ranker })` → default `scopeSpecificityRanker`.

### Migration

Move ordering into the provider factory `ranker` if you need to override source-level rankers.

---

## 10. `mockKnowledgeSource` stores `scope` (K14)

### Am I affected?

You use `mockKnowledgeSource` in tests and pass `scope` metadata.

### What changed

`opts.scope` is persisted on `KnowledgeSourceDefinition.scope`. `getBlock` still returns the fixed string unless you customize the provider.

### Migration

No action required unless you assert definition metadata in tests.

---

## 11. KB forbidden-import CI test (K15)

### Am I affected?

You maintain a fork of `@plumbus/knowledge-base` that imports vector-store internals.

### What changed

`no-vector-store-imports.test.ts` fails CI when package sources import forbidden core vector symbols.

### Migration

Keep ingest/retrieve in `@plumbus/core`; KB stays an adapter.
