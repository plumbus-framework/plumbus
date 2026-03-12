# Runtime Risk Mitigation Notes

Date: 2026-03-12  
Scope: `packages/plumbus-core` runtime paths (`flows`, `events`, `auth`, `worker bootstrap`)

## Prioritized Findings

## 1) High: Flows are started but not progressed
- Risk: flow executions can remain stuck after `start()` because `runNext()` is not wired into worker runtime.
- Evidence:
  - `runNext()` exists: `packages/plumbus-core/src/flows/engine.ts:121`
  - Worker constructs flow engine but does not invoke a runner loop: `packages/plumbus-core/src/worker/bootstrap.ts:112`
- Mitigation ideas:
  - Add a flow execution worker loop that polls runnable executions and calls `runNext()`.
  - Define scheduling contract for waiting/delayed flows and transition conditions.
  - Add integration tests that start a flow and assert terminal completion.

## 2) High: Scheduler enabled flag check is type-mismatched
- Risk: scheduled flows may never trigger.
- Evidence:
  - DB schema uses boolean: `packages/plumbus-core/src/flows/schema.ts:73`
  - Runtime compares to string `"true"`: `packages/plumbus-core/src/flows/scheduler.ts:77`
- Mitigation ideas:
  - Change guard to boolean check (`if (!schedule.enabled) continue`).
  - Add a test for enabled/disabled schedule behavior.

## 3) High: JWT adapter does not verify signatures
- Risk: forged tokens can be accepted if payload fields look valid.
- Evidence:
  - JWT payload is only decoded/parsing-based: `packages/plumbus-core/src/auth/adapter.ts:47`, `packages/plumbus-core/src/auth/adapter.ts:63`
  - Server fallback secret is permissive for accidental non-dev use: `packages/plumbus-core/src/server/bootstrap.ts:74`
- Mitigation ideas:
  - Replace decode-only logic with verified JWT validation (e.g., JOSE).
  - Fail startup in non-development environments when auth secret/config is missing.
  - Add auth negative tests for invalid signatures and wrong issuer/audience.

## 4) Medium-High: Outbox dispatcher is vulnerable to duplicate dispatch
- Risk: duplicate event publication under overlapping polls or multiple dispatcher instances.
- Evidence:
  - Poll loop has no in-flight guard/claiming and runs on interval: `packages/plumbus-core/src/events/dispatcher.ts:45`, `packages/plumbus-core/src/events/dispatcher.ts:141`
  - Rows are selected then published before status update: `packages/plumbus-core/src/events/dispatcher.ts:51`, `packages/plumbus-core/src/events/dispatcher.ts:86`
- Mitigation ideas:
  - Use row claiming/locking (`FOR UPDATE SKIP LOCKED`) or atomic status transition before publish.
  - Add single-flight guard to prevent overlapping `poll()` executions per process.
  - Add concurrency tests with two dispatcher instances.

## 5) Medium: Flow dead-letter sweep is not idempotent
- Risk: repeated sweeps can insert duplicate dead-letter records for the same execution.
- Evidence:
  - Insert into dead-letter table without marking source as swept: `packages/plumbus-core/src/flows/dead-letter.ts:29`, `packages/plumbus-core/src/flows/dead-letter.ts:56`
- Mitigation ideas:
  - Add a unique constraint on dead-letter `executionId`, or mark source row as archived/swept.
  - Perform move in a transaction with deterministic conflict handling.

## 6) Medium: Delay steps wait without a guaranteed wake-up path
- Risk: delayed flows can remain waiting indefinitely.
- Evidence:
  - Delay result sets waiting state and next step but no due-at persistence: `packages/plumbus-core/src/flows/engine.ts:208`
  - Step executor returns duration only: `packages/plumbus-core/src/flows/step-executor.ts:127`
- Mitigation ideas:
  - Persist `resumeAt`/`wakeAt` timestamp on execution rows.
  - Add worker logic to resume due delayed executions.
  - Add end-to-end test for delay->resume->completion.

## Suggested Mitigation Phasing

## Phase P0 (security + functionality blockers)
- Wire flow progression worker (`runNext()` execution path).
- Fix scheduler enabled check.
- Implement verified JWT handling and tighten non-dev bootstrap defaults.

## Phase P1 (reliability hardening)
- Outbox dispatcher dedup/concurrency safety.
- Idempotent flow dead-letter sweeping.
- Delay wake-up persistence and resumption.

## Verification Checklist
- Add integration tests for:
  - flow start to completion path
  - scheduled flow execution with enabled/disabled states
  - dispatcher duplicate resistance under concurrency
  - delayed flow automatic resume behavior
  - JWT signature rejection and claim validation
- Run full package test suite and capture regressions.

## Note
- In this environment, test execution was blocked because `pnpm` was not available.
