# Plan 02 progress — 2026-08-20 (session 14)

**Repo:** `/home/marik/Projects/Plumbus` (branch `plumbus-next`)  
**Git:** source and docs only. No `add` / `commit`.  
**Stage 3 / 4 / 5 / 6:** not reopened. E5 and E6 stay claimed. Stage 6b not started.

## Stage identity

| Plan stage | Status |
|---|---|
| Stage 1 — F-03 protocol + crash-matrix | Done |
| Stage 2 — isolation narrowings | Already delivered; not redone |
| Stage 3 — durable dispatch core | Extra process-SIGKILL remains skipped. |
| Stage 4 — Human tasks, approvals, risk tiers | **Closed on the Plumbus side.** |
| Stage 5 — Declarative flow definitions | **Closed on the Plumbus side.** E5 claimed. |
| Stage 6 — Timers, subscriptions, cancel/compensate, budgets | **Opened.** E6 claimed. |
| Stage 6b — Governed AI | **Not started.** Mid-feature files from an interrupted start were deleted. |

## This session — framework vs app coupling

Plumbus is a generic app framework. This session did **not** add Quinovium product features. It stripped leaked host-app names and comments.

### Stripped

- Unwired Stage 6b drafts (`governed-catalog.ts`, `governed-host.ts`, `governed-invoke.ts`) — incomplete, deleted.
- E5 harness fixtures: `on-document-submitted` / `security-cleared` / `evidence-ready` / `evaluation.*` → `example.flow-a|b|c` and `example.accept|queue|record|…`.
- Production comments that named Quinovium / WS-F / `tenant_qv%` as if they were framework owners or apply targets. Replaced with "host application" / "application tenant databases".

### Kept (generic)

- Durable dispatch, persist-before-ack, approvals, compiled flows, scheduler catch-up, subscriptions, cancel/compensate, budgets, host-supplied `authorizationProvider`.
- `tenant_qv` **only** as a negative harness assertion (do not create those DB names). Not an API, type, table, or CLI.
- RAG `documentId` and step-executor `$state.documentId` examples — generic document store, not an evaluation pipeline.
- `DEC-14` action-risk tier names (`read-only` / `limited-reversible` / `consequential`) — framework vocabulary, Quinovium path comment removed.

### Not found

- No imports from `/home/marik/Projects/Quinovium`.
- No `qv-dev`, `Asia/Jerusalem` default, college/course/section entities, or C-AST/C-IAM names in `plumbus-core` src.

## Remaining

- Stage 6b not started (on purpose).
- Negative `tenant_qv` assertions stay in harness tests as a safety check for this program's Postgres.
